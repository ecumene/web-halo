/* Virtual IPv4 sockets for the browser build.

Local traffic stays entirely in process.  Remote peers are represented by
100.64.0.0/10 addresses and carried by the two WebRTC DataChannels managed in
library_web_transport.js.  The reliable channel preserves TCP byte-stream
ordering; the unreliable channel preserves one UDP datagram per message. */

#include "web_loopback_net.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>

#include "p2p.h"

#if defined(WEB_NET_TEST)
#define EMSCRIPTEN_KEEPALIVE
extern int web_transport_send(unsigned long address, int reliable,
	const void *buffer, int length);
#elif defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
extern int web_transport_send(unsigned long address, int reliable,
	const void *buffer, int length);
#else
#define EMSCRIPTEN_KEEPALIVE
static int web_transport_send(unsigned long address, int reliable,
	const void *buffer, int length)
{
	(void)address;
	(void)reliable;
	(void)buffer;
	(void)length;
	return 0;
}
#endif

#define WEB_NET_DESCRIPTOR_BASE 0x4000
#define WEB_NET_MAXIMUM_SOCKETS 256
#define WEB_NET_MAXIMUM_PENDING 128
#define WEB_NET_DEFAULT_BUFFER_SIZE (256 * 1024)
#define WEB_NET_MAXIMUM_REMOTE_PEERS 127
#define WEB_NET_IDENTIFIER_SIZE 6
#define WEB_NET_FRAME_HEADER_SIZE 12
#define WEB_NET_MAXIMUM_DATAGRAM_SIZE 1500
#define WEB_NET_STREAM_CHUNK_SIZE (16 * 1024)
#define WEB_NET_MAXIMUM_FRAME_SIZE (WEB_NET_FRAME_HEADER_SIZE + WEB_NET_STREAM_CHUNK_SIZE)
#define WEB_NET_RELIABLE_OUTBOUND_LIMIT (1024 * 1024)
#define WEB_NET_UNRELIABLE_OUTBOUND_LIMIT (256 * 1024)
#define WEB_NET_OUTBOUND_FLUSH_BURST 256

enum web_net_frame_type
{
	_web_net_frame_datagram = 1,
	_web_net_frame_stream_open,
	_web_net_frame_stream_data,
	_web_net_frame_stream_close,
};

enum
{
	WEB_NET_FRAME_MAGIC = 0x48,
	WEB_NET_FRAME_VERSION = 1,
};

struct web_datagram
{
	struct web_datagram *next;
	struct sockaddr_in source;
	int length;
	unsigned char data[];
};

struct web_socket
{
	int used;
	int family;
	int type;
	int protocol;
	int nonblocking;
	int bound;
	int connected;
	int listening;
	int shut_read;
	int shut_write;
	int peer_closed;
	int peer_descriptor;
	int remote_peer;
	unsigned long remote_connection;
	int send_buffer_size;
	int receive_buffer_size;
	struct sockaddr_in local_address;
	struct sockaddr_in peer_address;
	unsigned char *stream_data;
	size_t stream_offset;
	size_t stream_length;
	size_t stream_capacity;
	struct web_datagram *datagram_first;
	struct web_datagram *datagram_last;
	size_t datagram_bytes;
	int datagram_count;
	int pending[WEB_NET_MAXIMUM_PENDING];
	int pending_first;
	int pending_count;
};

struct web_remote_peer
{
	int used;
	int connected;
	int reliable_writeable;
	int unreliable_writeable;
	unsigned char identifier[WEB_NET_IDENTIFIER_SIZE];
	unsigned long address;
	unsigned long next_connection;
	size_t reliable_queued_bytes;
	size_t unreliable_queued_bytes;
};

struct web_outbound_frame
{
	struct web_outbound_frame *next;
	unsigned long address;
	int reliable;
	int length;
	unsigned char data[];
};

static struct web_socket web_sockets[WEB_NET_MAXIMUM_SOCKETS];
static struct web_remote_peer web_remote_peers[WEB_NET_MAXIMUM_REMOTE_PEERS];
static pthread_mutex_t web_sockets_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t web_sockets_condition = PTHREAD_COND_INITIALIZER;
static pthread_mutex_t web_outbound_flush_mutex = PTHREAD_MUTEX_INITIALIZER;
static unsigned short next_ephemeral_port = 40000;
static unsigned char web_remote_ingress[WEB_NET_MAXIMUM_FRAME_SIZE];
static struct web_outbound_frame *web_outbound_first;
static struct web_outbound_frame *web_outbound_last;

static int descriptor_for_index(int index)
{
	return WEB_NET_DESCRIPTOR_BASE + index;
}

static int index_for_descriptor(int descriptor)
{
	int index = descriptor - WEB_NET_DESCRIPTOR_BASE;

	return index >= 0 && index < WEB_NET_MAXIMUM_SOCKETS ? index : -1;
}

static struct web_socket *socket_for_descriptor_locked(int descriptor)
{
	int index = index_for_descriptor(descriptor);

	if (index < 0 || !web_sockets[index].used)
		return NULL;
	return &web_sockets[index];
}

static int fail_with(int error)
{
	errno = error;
	return -1;
}

static int allocate_socket_locked(int family, int type, int protocol)
{
	int index;

	for (index = 0; index < WEB_NET_MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *socket = &web_sockets[index];

		if (socket->used)
			continue;
		memset(socket, 0, sizeof(*socket));
		socket->used = 1;
		socket->family = family;
		socket->type = type;
		socket->protocol = protocol;
		socket->peer_descriptor = -1;
		socket->remote_peer = -1;
		socket->send_buffer_size = WEB_NET_DEFAULT_BUFFER_SIZE;
		socket->receive_buffer_size = WEB_NET_DEFAULT_BUFFER_SIZE;
		socket->local_address.sin_family = AF_INET;
		socket->peer_address.sin_family = AF_INET;
		return descriptor_for_index(index);
	}
	return fail_with(ENOBUFS);
}

static int address_matches(const struct sockaddr_in *bound, const struct sockaddr_in *target)
{
	return bound->sin_port == target->sin_port &&
		(bound->sin_addr.s_addr == htonl(INADDR_ANY) ||
		 target->sin_addr.s_addr == htonl(INADDR_BROADCAST) ||
		 bound->sin_addr.s_addr == target->sin_addr.s_addr);
}

static int port_is_available_locked(int type, unsigned short network_port)
{
	int index;

	for (index = 0; index < WEB_NET_MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *socket = &web_sockets[index];

		if (socket->used && socket->bound && socket->type == type &&
			socket->local_address.sin_port == network_port)
			return 0;
	}
	return 1;
}

static unsigned short allocate_port_locked(int type)
{
	unsigned int attempts;

	for (attempts = 0; attempts < 20000; attempts++)
	{
		unsigned short host_port = next_ephemeral_port++;
		unsigned short network_port;

		if (next_ephemeral_port < 40000 || next_ephemeral_port >= 60000)
			next_ephemeral_port = 40000;
		network_port = htons(host_port);
		if (port_is_available_locked(type, network_port))
			return network_port;
	}
	return 0;
}

static int bind_ephemeral_locked(struct web_socket *socket)
{
	unsigned short port;

	if (socket->bound)
		return 0;
	port = allocate_port_locked(socket->type);
	if (!port)
		return fail_with(EADDRINUSE);
	socket->local_address.sin_family = AF_INET;
	socket->local_address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	socket->local_address.sin_port = port;
	socket->bound = 1;
	return 0;
}

static void free_datagrams_locked(struct web_socket *socket)
{
	struct web_datagram *datagram = socket->datagram_first;

	while (datagram)
	{
		struct web_datagram *next = datagram->next;

		free(datagram);
		datagram = next;
	}
	socket->datagram_first = NULL;
	socket->datagram_last = NULL;
	socket->datagram_bytes = 0;
	socket->datagram_count = 0;
}

static void detach_peer_locked(int descriptor, struct web_socket *socket)
{
	struct web_socket *peer = socket_for_descriptor_locked(socket->peer_descriptor);

	(void)descriptor;
	if (peer && peer->peer_descriptor == descriptor)
	{
		peer->peer_descriptor = -1;
		peer->peer_closed = 1;
		pthread_cond_broadcast(&web_sockets_condition);
	}
	socket->peer_descriptor = -1;
}

static void close_remote_stream_locked(struct web_socket *socket, int send_close);

static void release_socket_locked(int descriptor)
{
	struct web_socket *socket = socket_for_descriptor_locked(descriptor);
	int pending_index;

	if (!socket)
		return;
	if (socket->remote_peer >= 0)
		close_remote_stream_locked(socket, 1);
	detach_peer_locked(descriptor, socket);
	for (pending_index = 0; pending_index < socket->pending_count; pending_index++)
	{
		int accepted_descriptor = socket->pending[
			(socket->pending_first + pending_index) % WEB_NET_MAXIMUM_PENDING];
		struct web_socket *accepted = socket_for_descriptor_locked(accepted_descriptor);

		if (accepted)
		{
			if (accepted->remote_peer >= 0)
				close_remote_stream_locked(accepted, 1);
			detach_peer_locked(accepted_descriptor, accepted);
			free(accepted->stream_data);
			free_datagrams_locked(accepted);
			memset(accepted, 0, sizeof(*accepted));
		}
	}
	free(socket->stream_data);
	free_datagrams_locked(socket);
	memset(socket, 0, sizeof(*socket));
	pthread_cond_broadcast(&web_sockets_condition);
}

static int append_stream_locked(struct web_socket *socket, const void *buffer, int length)
{
	size_t needed;

	if (length < 0)
		return fail_with(EINVAL);
	needed = socket->stream_length + (size_t)length;
	if (needed > (size_t)socket->receive_buffer_size)
		return fail_with(EAGAIN);
	if (socket->stream_offset && socket->stream_offset + needed > socket->stream_capacity)
	{
		memmove(socket->stream_data,
			socket->stream_data + socket->stream_offset,
			socket->stream_length);
		socket->stream_offset = 0;
	}
	if (socket->stream_offset + needed > socket->stream_capacity)
	{
		size_t capacity = socket->stream_capacity ? socket->stream_capacity : 4096;
		unsigned char *data;

		while (capacity < needed)
			capacity *= 2;
		data = realloc(socket->stream_data, capacity);
		if (!data)
			return fail_with(ENOBUFS);
		socket->stream_data = data;
		socket->stream_capacity = capacity;
	}
	memcpy(socket->stream_data + socket->stream_offset + socket->stream_length,
		buffer, (size_t)length);
	socket->stream_length += (size_t)length;
	return length;
}

static int enqueue_datagram_locked(struct web_socket *socket, const void *buffer,
	int length, const struct sockaddr_in *source)
{
	struct web_datagram *datagram;

	if (length < 0)
		return fail_with(EINVAL);
	if (length > socket->receive_buffer_size)
		return fail_with(EMSGSIZE);
	/* UDP is freshness-sensitive.  Bound its memory and evict the oldest
	packet instead of letting a stalled game grow the Wasm heap forever. */
	while (socket->datagram_first &&
		(socket->datagram_bytes + (size_t)length > (size_t)socket->receive_buffer_size ||
		 socket->datagram_count >= 512))
	{
		struct web_datagram *oldest = socket->datagram_first;

		socket->datagram_first = oldest->next;
		if (!socket->datagram_first)
			socket->datagram_last = NULL;
		socket->datagram_bytes -= (size_t)oldest->length;
		socket->datagram_count--;
		free(oldest);
	}
	datagram = malloc(sizeof(*datagram) + (size_t)length);
	if (!datagram)
		return fail_with(ENOBUFS);
	datagram->next = NULL;
	datagram->source = *source;
	datagram->length = length;
	memcpy(datagram->data, buffer, (size_t)length);
	if (socket->datagram_last)
		socket->datagram_last->next = datagram;
	else
		socket->datagram_first = datagram;
	socket->datagram_last = datagram;
	socket->datagram_bytes += (size_t)length;
	socket->datagram_count++;
	return length;
}

static struct web_remote_peer *remote_peer_for_address_locked(unsigned long address)
{
	int index;

	for (index = 0; index < WEB_NET_MAXIMUM_REMOTE_PEERS; index++)
	{
		struct web_remote_peer *peer = &web_remote_peers[index];

		if (peer->used && peer->address == address)
			return peer;
	}
	return NULL;
}

static int remote_peer_index_for_address_locked(unsigned long address)
{
	struct web_remote_peer *peer = remote_peer_for_address_locked(address);

	return peer ? (int)(peer - web_remote_peers) : -1;
}

static void frame_put_short(unsigned char *bytes, unsigned short network_value)
{
	memcpy(bytes, &network_value, sizeof(network_value));
}

static unsigned short frame_get_short(const unsigned char *bytes)
{
	unsigned short value;

	memcpy(&value, bytes, sizeof(value));
	return value;
}

static void frame_put_long(unsigned char *bytes, unsigned long value)
{
	uint32_t wire = htonl((uint32_t)value);

	memcpy(bytes, &wire, sizeof(wire));
}

static unsigned long frame_get_long(const unsigned char *bytes)
{
	uint32_t wire;

	memcpy(&wire, bytes, sizeof(wire));
	return (unsigned long)ntohl(wire);
}

static int send_remote_frame_locked(struct web_remote_peer *peer, int type,
	unsigned long connection, unsigned short source_port,
	unsigned short destination_port, const void *payload, int payload_length)
{
	struct web_outbound_frame *frame;
	size_t *queued_bytes;
	size_t queue_limit;
	int reliable = type != _web_net_frame_datagram;
	int frame_length;

	if (!peer || !peer->used || !peer->connected)
		return fail_with(ENETUNREACH);
	if (payload_length < 0 || payload_length > WEB_NET_STREAM_CHUNK_SIZE ||
		(type == _web_net_frame_datagram && payload_length > WEB_NET_MAXIMUM_DATAGRAM_SIZE))
		return fail_with(EMSGSIZE);
	frame_length = WEB_NET_FRAME_HEADER_SIZE + payload_length;
	queued_bytes = reliable ? &peer->reliable_queued_bytes :
		&peer->unreliable_queued_bytes;
	queue_limit = reliable ? WEB_NET_RELIABLE_OUTBOUND_LIMIT :
		WEB_NET_UNRELIABLE_OUTBOUND_LIMIT;
	/* Empty reliable frames are open/close control messages.  Their tiny,
	bounded overhead may use the reserve above the data limit so a full stream
	queue cannot suppress its eventual close. */
	if ((!reliable || payload_length) &&
		*queued_bytes + (size_t)frame_length > queue_limit)
		return fail_with(EAGAIN);
	frame = malloc(sizeof(*frame) + (size_t)frame_length);
	if (!frame)
		return fail_with(ENOBUFS);
	frame->next = NULL;
	frame->address = peer->address;
	frame->reliable = reliable;
	frame->length = frame_length;
	frame->data[0] = WEB_NET_FRAME_MAGIC;
	frame->data[1] = WEB_NET_FRAME_VERSION;
	frame->data[2] = (unsigned char)type;
	frame->data[3] = 0;
	frame_put_long(frame->data + 4, connection);
	frame_put_short(frame->data + 8, source_port);
	frame_put_short(frame->data + 10, destination_port);
	if (payload_length)
		memcpy(frame->data + WEB_NET_FRAME_HEADER_SIZE, payload, (size_t)payload_length);
	if (web_outbound_last)
		web_outbound_last->next = frame;
	else
		web_outbound_first = frame;
	web_outbound_last = frame;
	*queued_bytes += (size_t)frame_length;
	return payload_length;
}

/* DataChannel calls are sync-proxied to the browser main thread.  Never make
one while web_sockets_mutex is held: a browser callback may concurrently try
to enter the C bridge.  A bounded C queue gives send() normal kernel-buffer
semantics and lets this flusher stage each frame before crossing into JS. */
static void flush_remote_outbound(void)
{
	int count;

	if (pthread_mutex_trylock(&web_outbound_flush_mutex) != 0)
		return;
	for (count = 0; count < WEB_NET_OUTBOUND_FLUSH_BURST; count++)
	{
		struct web_outbound_frame *frame = NULL;
		struct web_outbound_frame *previous = NULL;
		struct web_outbound_frame *cursor;
		struct web_remote_peer *peer;
		int sent;

		pthread_mutex_lock(&web_sockets_mutex);
		cursor = web_outbound_first;
		while (cursor)
		{
			peer = remote_peer_for_address_locked(cursor->address);
			if (!peer || !peer->connected)
			{
				struct web_outbound_frame *stale = cursor;

				cursor = cursor->next;
				if (previous)
					previous->next = cursor;
				else
					web_outbound_first = cursor;
				if (web_outbound_last == stale)
					web_outbound_last = previous;
				if (peer)
				{
					size_t *bytes = stale->reliable ? &peer->reliable_queued_bytes :
						&peer->unreliable_queued_bytes;

					*bytes -= (size_t)stale->length;
				}
				free(stale);
				continue;
			}
			if ((cursor->reliable && peer->reliable_writeable) ||
				(!cursor->reliable && peer->unreliable_writeable))
			{
				frame = cursor;
				if (previous)
					previous->next = cursor->next;
				else
					web_outbound_first = cursor->next;
				if (web_outbound_last == cursor)
					web_outbound_last = previous;
				if (frame->reliable)
					peer->reliable_queued_bytes -= (size_t)frame->length;
				else
					peer->unreliable_queued_bytes -= (size_t)frame->length;
				break;
			}
			previous = cursor;
			cursor = cursor->next;
		}
		pthread_mutex_unlock(&web_sockets_mutex);
		if (!frame)
			break;

		/* No socket lock is held across this browser-main-thread call. */
		sent = web_transport_send(frame->address, frame->reliable,
			frame->data, frame->length);
		if (!sent)
		{
			pthread_mutex_lock(&web_sockets_mutex);
			peer = remote_peer_for_address_locked(frame->address);
			if (peer && peer->connected)
			{
				if (frame->reliable)
				{
					peer->reliable_writeable = 0;
					peer->reliable_queued_bytes += (size_t)frame->length;
				}
				else
				{
					peer->unreliable_writeable = 0;
					peer->unreliable_queued_bytes += (size_t)frame->length;
				}
				frame->next = web_outbound_first;
				web_outbound_first = frame;
				if (!web_outbound_last)
					web_outbound_last = frame;
				frame = NULL;
			}
			pthread_mutex_unlock(&web_sockets_mutex);
			if (frame)
				free(frame);
			break;
		}
		free(frame);
	}
	pthread_mutex_unlock(&web_outbound_flush_mutex);
}

static void discard_remote_outbound_locked(unsigned long address)
{
	struct web_outbound_frame *previous = NULL;
	struct web_outbound_frame *frame = web_outbound_first;

	while (frame)
	{
		struct web_outbound_frame *next = frame->next;

		if (frame->address == address)
		{
			if (previous)
				previous->next = next;
			else
				web_outbound_first = next;
			if (web_outbound_last == frame)
				web_outbound_last = previous;
			free(frame);
		}
		else
		{
			previous = frame;
		}
		frame = next;
	}
}

static void close_remote_stream_locked(struct web_socket *socket, int send_close)
{
	if (socket->remote_peer >= 0 && socket->remote_peer < WEB_NET_MAXIMUM_REMOTE_PEERS)
	{
		struct web_remote_peer *peer = &web_remote_peers[socket->remote_peer];

		if (send_close && !socket->shut_write && peer->used && peer->connected)
			(void)send_remote_frame_locked(peer, _web_net_frame_stream_close,
				socket->remote_connection, 0, 0, NULL, 0);
	}
	socket->remote_peer = -1;
	socket->remote_connection = 0;
}

static int is_remote_address(unsigned long address)
{
	return (ntohl(address) & 0xFFC00000u) == 0x64400000u;
}

static int send_datagram_locked(struct web_socket *socket, const void *buffer,
	int length, const struct sockaddr_in *target)
{
	struct sockaddr_in source;
	struct web_remote_peer *remote;
	int index;

	if (bind_ephemeral_locked(socket) < 0)
		return -1;
	source = socket->local_address;
	if (source.sin_addr.s_addr == htonl(INADDR_ANY))
		source.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	remote = remote_peer_for_address_locked(target->sin_addr.s_addr);
	if (remote)
		return send_remote_frame_locked(remote, _web_net_frame_datagram, 0,
			source.sin_port, target->sin_port, buffer, length) < 0 ? -1 : length;
	if (is_remote_address(target->sin_addr.s_addr))
		return fail_with(ENETUNREACH);
	for (index = 0; index < WEB_NET_MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *receiver = &web_sockets[index];

		if (!receiver->used || receiver->type != SOCK_DGRAM || !receiver->bound ||
			receiver->shut_read || !address_matches(&receiver->local_address, target))
			continue;
		if (receiver->connected &&
			(receiver->peer_address.sin_port != source.sin_port ||
			 receiver->peer_address.sin_addr.s_addr != source.sin_addr.s_addr))
			continue;
		if (enqueue_datagram_locked(receiver, buffer, length, &source) < 0)
			return -1;
		pthread_cond_broadcast(&web_sockets_condition);
		if (target->sin_addr.s_addr != htonl(INADDR_BROADCAST))
			break;
	}
	if (target->sin_addr.s_addr == htonl(INADDR_BROADCAST))
	{
		for (index = 0; index < WEB_NET_MAXIMUM_REMOTE_PEERS; index++)
		{
			struct web_remote_peer *peer = &web_remote_peers[index];

			if (!peer->used || !peer->connected)
				continue;
			/* A broadcast remains successful even if one remote channel becomes
			backpressured, matching UDP's best-effort semantics. */
			(void)send_remote_frame_locked(peer, _web_net_frame_datagram, 0,
				source.sin_port, target->sin_port, buffer, length);
		}
	}

	/* UDP succeeds even when nobody receives the datagram. */
	return length;
}

static int receive_datagram_locked(struct web_socket *socket, void *buffer,
	int length, void *address, int *address_length)
{
	struct web_datagram *datagram = socket->datagram_first;
	int copied;

	if (!datagram)
		return fail_with(EAGAIN);
	socket->datagram_first = datagram->next;
	if (!socket->datagram_first)
		socket->datagram_last = NULL;
	copied = length < datagram->length ? length : datagram->length;
	memcpy(buffer, datagram->data, (size_t)copied);
	if (address && address_length)
	{
		int address_copied = *address_length < (int)sizeof(datagram->source) ?
			*address_length : (int)sizeof(datagram->source);

		memcpy(address, &datagram->source, (size_t)address_copied);
		*address_length = address_copied;
	}
	socket->datagram_bytes -= (size_t)datagram->length;
	socket->datagram_count--;
	free(datagram);
	return copied;
}

static int socket_readable_locked(const struct web_socket *socket)
{
	if (socket->listening)
		return socket->pending_count > 0;
	if (socket->type == SOCK_DGRAM)
		return socket->datagram_first != NULL;
	return socket->stream_length > 0 || socket->peer_closed;
}

static int socket_writeable_locked(const struct web_socket *socket)
{
	if (socket->type == SOCK_DGRAM)
		return !socket->shut_write;
	if (!socket->connected || socket->shut_write)
		return 0;
	if (socket->remote_peer >= 0)
	{
		const struct web_remote_peer *peer = &web_remote_peers[socket->remote_peer];

		return peer->used && peer->connected && !socket->peer_closed &&
			peer->reliable_queued_bytes < WEB_NET_RELIABLE_OUTBOUND_LIMIT;
	}
	{
		const struct web_socket *peer = socket_for_descriptor_locked(socket->peer_descriptor);

		return peer && !peer->shut_read &&
			peer->stream_length < (size_t)peer->receive_buffer_size;
	}
}

int web_net_socket(int family, int type, int protocol)
{
	int descriptor;

	if (family != AF_INET)
		return fail_with(EAFNOSUPPORT);
	if (type != SOCK_STREAM && type != SOCK_DGRAM)
		return fail_with(EPROTOTYPE);
	pthread_mutex_lock(&web_sockets_mutex);
	descriptor = allocate_socket_locked(family, type, protocol);
	pthread_mutex_unlock(&web_sockets_mutex);
	return descriptor;
}

int web_net_close(int descriptor)
{
	pthread_mutex_lock(&web_sockets_mutex);
	if (!socket_for_descriptor_locked(descriptor))
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(EBADF);
	}
	release_socket_locked(descriptor);
	pthread_mutex_unlock(&web_sockets_mutex);
	flush_remote_outbound();
	return 0;
}

int web_net_bind(int descriptor, const void *address, int address_length)
{
	const struct sockaddr_in *requested = address;
	struct web_socket *socket;
	int index;

	if (!address || address_length < (int)sizeof(*requested) || requested->sin_family != AF_INET)
		return fail_with(EINVAL);
	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (socket->bound)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(EINVAL);
	}
	for (index = 0; index < WEB_NET_MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *other = &web_sockets[index];

		if (!requested->sin_port || !other->used || !other->bound || other->type != socket->type ||
			other->local_address.sin_port != requested->sin_port)
			continue;
		if (requested->sin_addr.s_addr == htonl(INADDR_ANY) ||
			other->local_address.sin_addr.s_addr == htonl(INADDR_ANY) ||
			requested->sin_addr.s_addr == other->local_address.sin_addr.s_addr)
		{
			pthread_mutex_unlock(&web_sockets_mutex);
			return fail_with(EADDRINUSE);
		}
	}
	socket->local_address = *requested;
	if (!socket->local_address.sin_port)
	{
		socket->local_address.sin_port = allocate_port_locked(socket->type);
		if (!socket->local_address.sin_port)
		{
			pthread_mutex_unlock(&web_sockets_mutex);
			return fail_with(EADDRINUSE);
		}
	}
	socket->bound = 1;
	pthread_mutex_unlock(&web_sockets_mutex);
	return 0;
}

int web_net_connect(int descriptor, const void *address, int address_length)
{
	const struct sockaddr_in *target = address;
	struct web_socket *socket;
	int listener_descriptor = -1;
	int index;

	if (!address || address_length < (int)sizeof(*target) || target->sin_family != AF_INET)
		return fail_with(EINVAL);
	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (socket->connected)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(EISCONN);
	}
	if (bind_ephemeral_locked(socket) < 0)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return -1;
	}
	if (socket->type == SOCK_DGRAM)
	{
		socket->peer_address = *target;
		socket->connected = 1;
		pthread_mutex_unlock(&web_sockets_mutex);
		return 0;
	}
	{
		int peer_index = remote_peer_index_for_address_locked(target->sin_addr.s_addr);

		if (peer_index >= 0)
		{
			struct web_remote_peer *peer = &web_remote_peers[peer_index];
			unsigned long connection;

			if (!peer->connected)
			{
				pthread_mutex_unlock(&web_sockets_mutex);
				return fail_with(ENETUNREACH);
			}
			peer->next_connection += 2;
			connection = peer->next_connection;
			if (!connection)
			{
				peer->next_connection += 2;
				connection = peer->next_connection;
			}
			if (send_remote_frame_locked(peer, _web_net_frame_stream_open,
				connection, socket->local_address.sin_port, target->sin_port,
				NULL, 0) < 0)
			{
				pthread_mutex_unlock(&web_sockets_mutex);
				return -1;
			}
			socket->connected = 1;
			socket->peer_address = *target;
			socket->remote_peer = peer_index;
			socket->remote_connection = connection;
			pthread_mutex_unlock(&web_sockets_mutex);
			flush_remote_outbound();
			return 0;
		}
		if (is_remote_address(target->sin_addr.s_addr))
		{
			pthread_mutex_unlock(&web_sockets_mutex);
			return fail_with(ENETUNREACH);
		}
	}
	for (index = 0; index < WEB_NET_MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *candidate = &web_sockets[index];

		if (candidate->used && candidate->type == SOCK_STREAM && candidate->listening &&
			address_matches(&candidate->local_address, target))
		{
			listener_descriptor = descriptor_for_index(index);
			break;
		}
	}
	if (listener_descriptor < 0)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ECONNREFUSED);
	}
	{
		struct web_socket *listener = socket_for_descriptor_locked(listener_descriptor);
		int accepted_descriptor;
		struct web_socket *accepted;

		if (listener->pending_count >= WEB_NET_MAXIMUM_PENDING)
		{
			pthread_mutex_unlock(&web_sockets_mutex);
			return fail_with(ECONNREFUSED);
		}
		accepted_descriptor = allocate_socket_locked(AF_INET, SOCK_STREAM, socket->protocol);
		if (accepted_descriptor < 0)
		{
			pthread_mutex_unlock(&web_sockets_mutex);
			return -1;
		}
		accepted = socket_for_descriptor_locked(accepted_descriptor);
		accepted->bound = 1;
		accepted->connected = 1;
		accepted->local_address = *target;
		accepted->peer_address = socket->local_address;
		accepted->peer_descriptor = descriptor;
		socket->connected = 1;
		socket->peer_address = *target;
		socket->peer_descriptor = accepted_descriptor;
		listener->pending[(listener->pending_first + listener->pending_count) %
			WEB_NET_MAXIMUM_PENDING] = accepted_descriptor;
		listener->pending_count++;
		pthread_cond_broadcast(&web_sockets_condition);
	}
	pthread_mutex_unlock(&web_sockets_mutex);
	flush_remote_outbound();
	return 0;
}

int web_net_listen(int descriptor, int backlog)
{
	struct web_socket *socket;

	(void)backlog;
	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (socket->type != SOCK_STREAM || !socket->bound)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(EINVAL);
	}
	socket->listening = 1;
	pthread_mutex_unlock(&web_sockets_mutex);
	return 0;
}

int web_net_accept(int descriptor, void *address, int *address_length)
{
	struct web_socket *listener;
	struct web_socket *accepted;
	int accepted_descriptor;

	pthread_mutex_lock(&web_sockets_mutex);
	listener = socket_for_descriptor_locked(descriptor);
	if (!listener)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (!listener->listening)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(EINVAL);
	}
	if (!listener->pending_count)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(EAGAIN);
	}
	accepted_descriptor = listener->pending[listener->pending_first];
	listener->pending_first = (listener->pending_first + 1) % WEB_NET_MAXIMUM_PENDING;
	listener->pending_count--;
	accepted = socket_for_descriptor_locked(accepted_descriptor);
	if (!accepted)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ECONNABORTED);
	}
	if (address && address_length)
	{
		int copied = *address_length < (int)sizeof(accepted->peer_address) ?
			*address_length : (int)sizeof(accepted->peer_address);

		memcpy(address, &accepted->peer_address, (size_t)copied);
		*address_length = copied;
	}
	pthread_mutex_unlock(&web_sockets_mutex);
	return accepted_descriptor;
}

int web_net_send(int descriptor, const void *buffer, int length, int flags)
{
	struct web_socket *socket;
	int result;

	(void)flags;
	if (!buffer || length < 0)
		return fail_with(EINVAL);
	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (socket->shut_write || !socket->connected)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTCONN);
	}
	if (socket->type == SOCK_DGRAM)
	{
		struct sockaddr_in target = socket->peer_address;

		result = send_datagram_locked(socket, buffer, length, &target);
		pthread_mutex_unlock(&web_sockets_mutex);
		flush_remote_outbound();
		return result;
	}
	if (socket->remote_peer >= 0)
	{
		struct web_remote_peer *peer;
		int chunk;

		if (socket->peer_closed || socket->remote_peer >= WEB_NET_MAXIMUM_REMOTE_PEERS)
		{
			pthread_mutex_unlock(&web_sockets_mutex);
			return fail_with(ECONNRESET);
		}
		peer = &web_remote_peers[socket->remote_peer];
		if (!peer->used || !peer->connected)
		{
			pthread_mutex_unlock(&web_sockets_mutex);
			return fail_with(ECONNRESET);
		}
		if (!length)
		{
			pthread_mutex_unlock(&web_sockets_mutex);
			return 0;
		}
		chunk = length < WEB_NET_STREAM_CHUNK_SIZE ? length : WEB_NET_STREAM_CHUNK_SIZE;
		result = send_remote_frame_locked(peer, _web_net_frame_stream_data,
			socket->remote_connection, 0, 0, buffer, chunk);
		pthread_mutex_unlock(&web_sockets_mutex);
		flush_remote_outbound();
		return result;
	}
	{
		struct web_socket *peer = socket_for_descriptor_locked(socket->peer_descriptor);

		if (!peer || peer->shut_read)
		{
			pthread_mutex_unlock(&web_sockets_mutex);
			return fail_with(ECONNRESET);
		}
		result = append_stream_locked(peer, buffer, length);
		if (result >= 0)
			pthread_cond_broadcast(&web_sockets_condition);
	}
	pthread_mutex_unlock(&web_sockets_mutex);
	return result;
}

int web_net_sendto(int descriptor, const void *buffer, int length, int flags,
	const void *address, int address_length)
{
	const struct sockaddr_in *target = address;
	struct web_socket *socket;
	int result;

	(void)flags;
	if (!buffer || length < 0 || !address || address_length < (int)sizeof(*target) ||
		target->sin_family != AF_INET)
		return fail_with(EINVAL);
	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (socket->type != SOCK_DGRAM || socket->shut_write)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(EOPNOTSUPP);
	}
	result = send_datagram_locked(socket, buffer, length, target);
	pthread_mutex_unlock(&web_sockets_mutex);
	flush_remote_outbound();
	return result;
}

int web_net_recv(int descriptor, void *buffer, int length, int flags)
{
	struct web_socket *socket;
	int copied;

	(void)flags;
	if (!buffer || length < 0)
		return fail_with(EINVAL);
	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (socket->type == SOCK_DGRAM)
	{
		copied = receive_datagram_locked(socket, buffer, length, NULL, NULL);
		pthread_mutex_unlock(&web_sockets_mutex);
		return copied;
	}
	if (socket->stream_length == 0)
	{
		int closed = socket->peer_closed;

		pthread_mutex_unlock(&web_sockets_mutex);
		return closed ? 0 : fail_with(EAGAIN);
	}
	copied = (size_t)length < socket->stream_length ? length : (int)socket->stream_length;
	memcpy(buffer, socket->stream_data + socket->stream_offset, (size_t)copied);
	socket->stream_offset += (size_t)copied;
	socket->stream_length -= (size_t)copied;
	if (!socket->stream_length)
		socket->stream_offset = 0;
	pthread_mutex_unlock(&web_sockets_mutex);
	return copied;
}

int web_net_recvfrom(int descriptor, void *buffer, int length, int flags,
	void *address, int *address_length)
{
	struct web_socket *socket;
	int copied;

	(void)flags;
	if (!buffer || length < 0)
		return fail_with(EINVAL);
	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (socket->type != SOCK_DGRAM)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(EOPNOTSUPP);
	}
	copied = receive_datagram_locked(socket, buffer, length, address, address_length);
	pthread_mutex_unlock(&web_sockets_mutex);
	return copied;
}

int web_net_shutdown(int descriptor, int how)
{
	struct web_socket *socket;

	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (how == SHUT_RD || how == SHUT_RDWR)
		socket->shut_read = 1;
	if (how == SHUT_WR || how == SHUT_RDWR)
	{
		if (socket->remote_peer >= 0 && !socket->shut_write)
		{
			struct web_remote_peer *peer = &web_remote_peers[socket->remote_peer];

			if (peer->used && peer->connected)
				(void)send_remote_frame_locked(peer, _web_net_frame_stream_close,
					socket->remote_connection, 0, 0, NULL, 0);
		}
		else
		{
			struct web_socket *peer = socket_for_descriptor_locked(socket->peer_descriptor);

			if (peer)
				peer->peer_closed = 1;
		}
		socket->shut_write = 1;
		pthread_cond_broadcast(&web_sockets_condition);
	}
	pthread_mutex_unlock(&web_sockets_mutex);
	flush_remote_outbound();
	return 0;
}

int web_net_set_nonblocking(int descriptor, int nonblocking)
{
	struct web_socket *socket;

	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	socket->nonblocking = !!nonblocking;
	pthread_mutex_unlock(&web_sockets_mutex);
	return 0;
}

int web_net_bytes_available(int descriptor, unsigned long *count)
{
	struct web_socket *socket;

	if (!count)
		return fail_with(EFAULT);
	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (socket->type == SOCK_DGRAM)
		*count = socket->datagram_first ? (unsigned long)socket->datagram_first->length : 0;
	else
		*count = (unsigned long)socket->stream_length;
	pthread_mutex_unlock(&web_sockets_mutex);
	return 0;
}

int web_net_setsockopt(int descriptor, int level, int name, const void *value, int length)
{
	struct web_socket *socket;

	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (level == SOL_SOCKET && value && length >= (int)sizeof(int))
	{
		if (name == SO_SNDBUF)
			socket->send_buffer_size = *(const int *)value;
		else if (name == SO_RCVBUF)
			socket->receive_buffer_size = *(const int *)value;
	}
	pthread_mutex_unlock(&web_sockets_mutex);
	return 0;
}

int web_net_getsockopt(int descriptor, int level, int name, void *value, int *length)
{
	struct web_socket *socket;
	int result;

	if (!value || !length || *length < (int)sizeof(int))
		return fail_with(EFAULT);
	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (level != SOL_SOCKET)
		result = 0;
	else if (name == SO_TYPE)
		result = socket->type;
	else if (name == SO_ERROR)
		result = 0;
	else if (name == SO_SNDBUF)
		result = socket->send_buffer_size;
	else if (name == SO_RCVBUF)
		result = socket->receive_buffer_size;
	else
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOPROTOOPT);
	}
	*(int *)value = result;
	*length = sizeof(int);
	pthread_mutex_unlock(&web_sockets_mutex);
	return 0;
}

static int copy_socket_address(const struct sockaddr_in *source, void *address, int *address_length)
{
	int copied;

	if (!address || !address_length)
		return fail_with(EFAULT);
	copied = *address_length < (int)sizeof(*source) ? *address_length : (int)sizeof(*source);
	memcpy(address, source, (size_t)copied);
	*address_length = copied;
	return 0;
}

int web_net_getsockname(int descriptor, void *address, int *address_length)
{
	struct web_socket *socket;
	int result;

	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	result = copy_socket_address(&socket->local_address, address, address_length);
	pthread_mutex_unlock(&web_sockets_mutex);
	return result;
}

int web_net_getpeername(int descriptor, void *address, int *address_length)
{
	struct web_socket *socket;
	int result;

	pthread_mutex_lock(&web_sockets_mutex);
	socket = socket_for_descriptor_locked(descriptor);
	if (!socket)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTSOCK);
	}
	if (!socket->connected)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return fail_with(ENOTCONN);
	}
	result = copy_socket_address(&socket->peer_address, address, address_length);
	pthread_mutex_unlock(&web_sockets_mutex);
	return result;
}

static int count_ready_locked(const int *descriptors, int count, int write)
{
	int index;
	int ready = 0;

	for (index = 0; index < count; index++)
	{
		struct web_socket *socket = socket_for_descriptor_locked(descriptors[index]);

		if (!socket)
			return fail_with(EBADF);
		if ((write && socket_writeable_locked(socket)) || (!write && socket_readable_locked(socket)))
			ready++;
	}
	return ready;
}

static void keep_ready_locked(int *descriptors, int *count, int write)
{
	int input_count = *count;
	int input_index;
	int output_count = 0;

	for (input_index = 0; input_index < input_count; input_index++)
	{
		struct web_socket *socket = socket_for_descriptor_locked(descriptors[input_index]);

		if ((write && socket_writeable_locked(socket)) || (!write && socket_readable_locked(socket)))
			descriptors[output_count++] = descriptors[input_index];
	}
	*count = output_count;
}

int web_net_select(int *read, int *read_count, int *write, int *write_count,
	int *error, int *error_count, long timeout_seconds, long timeout_microseconds,
	int infinite)
{
	struct timespec deadline;
	int read_ready;
	int write_ready;
	int index;
	int wait_result = 0;

	if (!infinite)
	{
		clock_gettime(CLOCK_REALTIME, &deadline);
		deadline.tv_sec += timeout_seconds + timeout_microseconds / 1000000;
		deadline.tv_nsec += (timeout_microseconds % 1000000) * 1000;
		if (deadline.tv_nsec >= 1000000000)
		{
			deadline.tv_sec++;
			deadline.tv_nsec -= 1000000000;
		}
	}

	pthread_mutex_lock(&web_sockets_mutex);
	for (;;)
	{
		read_ready = read ? count_ready_locked(read, *read_count, 0) : 0;
		if (read_ready < 0)
			goto failure;
		write_ready = write ? count_ready_locked(write, *write_count, 1) : 0;
		if (write_ready < 0)
			goto failure;
		if (error)
		{
			for (index = 0; index < *error_count; index++)
			{
				if (!socket_for_descriptor_locked(error[index]))
					goto failure_bad_descriptor;
			}
		}
		if (read_ready || write_ready)
			break;
		if (!infinite && timeout_seconds == 0 && timeout_microseconds == 0)
			break;
		wait_result = infinite ?
			pthread_cond_wait(&web_sockets_condition, &web_sockets_mutex) :
			pthread_cond_timedwait(&web_sockets_condition, &web_sockets_mutex, &deadline);
		if (wait_result == ETIMEDOUT)
			break;
		if (wait_result != 0)
		{
			errno = wait_result;
			goto failure;
		}
	}
	if (read)
		keep_ready_locked(read, read_count, 0);
	if (write)
		keep_ready_locked(write, write_count, 1);
	if (error)
		*error_count = 0;
	pthread_mutex_unlock(&web_sockets_mutex);
	flush_remote_outbound();
	return read_ready + write_ready;

failure_bad_descriptor:
	errno = EBADF;
failure:
	pthread_mutex_unlock(&web_sockets_mutex);
	return -1;
}

/* ---------- WebRTC bridge ---------- */

static struct web_socket *remote_stream_locked(int peer_index, unsigned long connection)
{
	int index;

	for (index = 0; index < WEB_NET_MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *socket = &web_sockets[index];

		if (socket->used && socket->type == SOCK_STREAM &&
			socket->remote_peer == peer_index &&
			socket->remote_connection == connection)
			return socket;
	}
	return NULL;
}

static int receive_remote_datagram_locked(int peer_index,
	unsigned short source_port, unsigned short destination_port,
	const void *payload, int payload_length)
{
	struct sockaddr_in source;
	struct sockaddr_in target;
	int index;

	memset(&source, 0, sizeof(source));
	source.sin_family = AF_INET;
	source.sin_addr.s_addr = web_remote_peers[peer_index].address;
	source.sin_port = source_port;
	memset(&target, 0, sizeof(target));
	target.sin_family = AF_INET;
	target.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	target.sin_port = destination_port;
	for (index = 0; index < WEB_NET_MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *receiver = &web_sockets[index];

		if (!receiver->used || receiver->type != SOCK_DGRAM || !receiver->bound ||
			receiver->shut_read || !address_matches(&receiver->local_address, &target))
			continue;
		if (receiver->connected &&
			(receiver->peer_address.sin_port != source.sin_port ||
			 receiver->peer_address.sin_addr.s_addr != source.sin_addr.s_addr))
			continue;
		if (enqueue_datagram_locked(receiver, payload, payload_length, &source) >= 0)
			pthread_cond_broadcast(&web_sockets_condition);
		/* Binding rules permit only one receiver for this unicast datagram. */
		break;
	}
	return 1;
}

static int receive_remote_stream_open_locked(int peer_index,
	unsigned long connection, unsigned short source_port,
	unsigned short destination_port)
{
	struct web_remote_peer *peer = &web_remote_peers[peer_index];
	struct web_socket *listener = NULL;
	struct web_socket *accepted;
	int accepted_descriptor;
	int index;

	if (!connection || !source_port || !destination_port)
		return -1;
	if (remote_stream_locked(peer_index, connection))
		return 1;
	for (index = 0; index < WEB_NET_MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *candidate = &web_sockets[index];

		if (candidate->used && candidate->type == SOCK_STREAM &&
			candidate->listening && candidate->bound &&
			candidate->local_address.sin_port == destination_port)
		{
			listener = candidate;
			break;
		}
	}
	/* An open for a port with no listener can be stale.  Consume it so one
	bad peer cannot permanently block all later reliable messages. */
	if (!listener || listener->pending_count >= WEB_NET_MAXIMUM_PENDING)
		return 1;
	accepted_descriptor = allocate_socket_locked(AF_INET, SOCK_STREAM, 0);
	if (accepted_descriptor < 0)
		return 0;
	accepted = socket_for_descriptor_locked(accepted_descriptor);
	accepted->bound = 1;
	accepted->connected = 1;
	accepted->local_address = listener->local_address;
	if (accepted->local_address.sin_addr.s_addr == htonl(INADDR_ANY))
		accepted->local_address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	accepted->peer_address.sin_family = AF_INET;
	accepted->peer_address.sin_addr.s_addr = peer->address;
	accepted->peer_address.sin_port = source_port;
	accepted->remote_peer = peer_index;
	accepted->remote_connection = connection;
	listener->pending[(listener->pending_first + listener->pending_count) %
		WEB_NET_MAXIMUM_PENDING] = accepted_descriptor;
	listener->pending_count++;
	pthread_cond_broadcast(&web_sockets_condition);
	return 1;
}

static int receive_remote_stream_data_locked(int peer_index,
	unsigned long connection, const void *payload, int payload_length)
{
	struct web_socket *socket = remote_stream_locked(peer_index, connection);

	if (!connection)
		return -1;
	/* Late data after a close is harmless and must not wedge the JS queue. */
	if (!socket || socket->shut_read || socket->peer_closed)
		return 1;
	if (socket->stream_length + (size_t)payload_length >
		(size_t)socket->receive_buffer_size)
		return 0;
	if (append_stream_locked(socket, payload, payload_length) < 0)
		return errno == EAGAIN ? 0 : -1;
	pthread_cond_broadcast(&web_sockets_condition);
	return 1;
}

static int receive_remote_stream_close_locked(int peer_index,
	unsigned long connection)
{
	struct web_socket *socket = remote_stream_locked(peer_index, connection);

	if (!connection)
		return -1;
	if (socket)
	{
		socket->peer_closed = 1;
		pthread_cond_broadcast(&web_sockets_condition);
	}
	return 1;
}

int web_net_peer_address(const unsigned char *identifier, unsigned long *address)
{
	int index;
	int found = 0;

	if (!identifier || !address)
		return 0;
	pthread_mutex_lock(&web_sockets_mutex);
	for (index = 0; index < WEB_NET_MAXIMUM_REMOTE_PEERS; index++)
	{
		struct web_remote_peer *peer = &web_remote_peers[index];

		if (peer->used && peer->connected &&
			!memcmp(peer->identifier, identifier, WEB_NET_IDENTIFIER_SIZE))
		{
			*address = peer->address;
			found = 1;
			break;
		}
	}
	pthread_mutex_unlock(&web_sockets_mutex);
	return found;
}

EMSCRIPTEN_KEEPALIVE unsigned long web_net_remote_add_peer(
	const void *identifier, int identifier_length)
{
	const unsigned char *bytes = identifier;
	const unsigned char *local_identifier;
	struct web_remote_peer *free_peer = NULL;
	unsigned long result = 0;
	int index;

	if (!bytes || identifier_length != WEB_NET_IDENTIFIER_SIZE)
		return 0;
	if (pthread_mutex_trylock(&web_sockets_mutex) != 0)
		return 0;
	for (index = 0; index < WEB_NET_MAXIMUM_REMOTE_PEERS; index++)
	{
		struct web_remote_peer *peer = &web_remote_peers[index];

		if (peer->used && !memcmp(peer->identifier, bytes, WEB_NET_IDENTIFIER_SIZE))
		{
			result = peer->address;
			goto finished;
		}
		if (!peer->used && !free_peer)
			free_peer = peer;
	}
	if (!free_peer)
		goto finished;
	index = (int)(free_peer - web_remote_peers);
	memset(free_peer, 0, sizeof(*free_peer));
	free_peer->used = 1;
	memcpy(free_peer->identifier, bytes, WEB_NET_IDENTIFIER_SIZE);
	free_peer->address = htonl(0x64400001u + (unsigned int)index);
	/* Each direction gets one parity of connection IDs, preventing the two
	ends from colliding when both open a stream at the same time. */
	local_identifier = p2p_identifier();
	free_peer->next_connection =
		memcmp(local_identifier, bytes, WEB_NET_IDENTIFIER_SIZE) < 0 ? 0 : 1;
	result = free_peer->address;

finished:
	pthread_mutex_unlock(&web_sockets_mutex);
	return result;
}

EMSCRIPTEN_KEEPALIVE int web_net_remote_remove_peer(unsigned long address)
{
	struct web_remote_peer *peer;
	int peer_index;
	int index;

	if (pthread_mutex_trylock(&web_sockets_mutex) != 0)
		return 0;
	peer = remote_peer_for_address_locked(address);
	if (!peer)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return 1;
	}
	peer_index = (int)(peer - web_remote_peers);
	for (index = 0; index < WEB_NET_MAXIMUM_SOCKETS; index++)
	{
		struct web_socket *socket = &web_sockets[index];

		if (socket->used && socket->remote_peer == peer_index)
		{
			socket->peer_closed = 1;
			socket->remote_peer = -1;
			socket->remote_connection = 0;
		}
	}
	discard_remote_outbound_locked(peer->address);
	memset(peer, 0, sizeof(*peer));
	pthread_cond_broadcast(&web_sockets_condition);
	pthread_mutex_unlock(&web_sockets_mutex);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int web_net_remote_set_peer_state(unsigned long address,
	int connected, int reliable_writeable, int unreliable_writeable)
{
	struct web_remote_peer *peer;
	int peer_index;
	int index;

	if (pthread_mutex_trylock(&web_sockets_mutex) != 0)
		return 0;
	peer = remote_peer_for_address_locked(address);
	if (!peer)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return -1;
	}
	peer_index = (int)(peer - web_remote_peers);
	peer->connected = !!connected;
	peer->reliable_writeable = !!reliable_writeable;
	peer->unreliable_writeable = !!unreliable_writeable;
	if (!peer->connected)
	{
		for (index = 0; index < WEB_NET_MAXIMUM_SOCKETS; index++)
		{
			struct web_socket *socket = &web_sockets[index];

			if (socket->used && socket->remote_peer == peer_index)
				socket->peer_closed = 1;
		}
	}
	pthread_cond_broadcast(&web_sockets_condition);
	pthread_mutex_unlock(&web_sockets_mutex);
	return 1;
}

EMSCRIPTEN_KEEPALIVE const void *web_net_remote_local_identifier(void)
{
	return p2p_identifier();
}

EMSCRIPTEN_KEEPALIVE void *web_net_remote_ingress_buffer(void)
{
	return web_remote_ingress;
}

EMSCRIPTEN_KEEPALIVE int web_net_remote_ingress_capacity(void)
{
	return sizeof(web_remote_ingress);
}

EMSCRIPTEN_KEEPALIVE int web_net_remote_receive(unsigned long address, int length)
{
	struct web_remote_peer *peer;
	unsigned long connection;
	unsigned short source_port;
	unsigned short destination_port;
	const unsigned char *payload;
	int payload_length;
	int peer_index;
	int result;

	if (length < WEB_NET_FRAME_HEADER_SIZE || length > (int)sizeof(web_remote_ingress) ||
		web_remote_ingress[0] != WEB_NET_FRAME_MAGIC ||
		web_remote_ingress[1] != WEB_NET_FRAME_VERSION ||
		web_remote_ingress[3] != 0)
		return -1;
	if (pthread_mutex_trylock(&web_sockets_mutex) != 0)
		return 0;
	peer = remote_peer_for_address_locked(address);
	if (!peer || !peer->connected)
	{
		pthread_mutex_unlock(&web_sockets_mutex);
		return -1;
	}
	peer_index = (int)(peer - web_remote_peers);
	connection = frame_get_long(web_remote_ingress + 4);
	source_port = frame_get_short(web_remote_ingress + 8);
	destination_port = frame_get_short(web_remote_ingress + 10);
	payload = web_remote_ingress + WEB_NET_FRAME_HEADER_SIZE;
	payload_length = length - WEB_NET_FRAME_HEADER_SIZE;
	switch (web_remote_ingress[2])
	{
	case _web_net_frame_datagram:
		result = connection == 0 && source_port && destination_port &&
			payload_length <= WEB_NET_MAXIMUM_DATAGRAM_SIZE ?
			receive_remote_datagram_locked(peer_index, source_port,
				destination_port, payload, payload_length) : -1;
		break;
	case _web_net_frame_stream_open:
		result = payload_length == 0 ?
			receive_remote_stream_open_locked(peer_index, connection,
				source_port, destination_port) : -1;
		break;
	case _web_net_frame_stream_data:
		result = source_port == 0 && destination_port == 0 &&
			payload_length <= WEB_NET_STREAM_CHUNK_SIZE ?
			receive_remote_stream_data_locked(peer_index, connection,
				payload, payload_length) : -1;
		break;
	case _web_net_frame_stream_close:
		result = source_port == 0 && destination_port == 0 && payload_length == 0 ?
			receive_remote_stream_close_locked(peer_index, connection) : -1;
		break;
	default:
		result = -1;
		break;
	}
	pthread_mutex_unlock(&web_sockets_mutex);
	return result;
}
