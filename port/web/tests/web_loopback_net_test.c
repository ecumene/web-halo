#include "web_loopback_net.h"

#include <arpa/inet.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>

enum { maximum_captured_frames = 64, maximum_frame_size = 16396 };

struct captured_frame
{
	unsigned long address;
	int reliable;
	int length;
	unsigned char bytes[maximum_frame_size];
};

static struct captured_frame captured[maximum_captured_frames];
static int captured_count;

const unsigned char *p2p_identifier(void)
{
	static const unsigned char identifier[6] = { 2, 0, 0, 0, 0, 1 };

	return identifier;
}

int web_transport_send(unsigned long address, int reliable,
	const void *buffer, int length)
{
	struct captured_frame *frame;

	assert(captured_count < maximum_captured_frames);
	assert(length <= maximum_frame_size);
	frame = &captured[captured_count++];
	frame->address = address;
	frame->reliable = reliable;
	frame->length = length;
	memcpy(frame->bytes, buffer, (size_t)length);
	return 1;
}

static struct sockaddr_in address(unsigned long ip, unsigned short port)
{
	struct sockaddr_in result;

	memset(&result, 0, sizeof(result));
	result.sin_family = AF_INET;
	result.sin_addr.s_addr = ip;
	result.sin_port = htons(port);
	return result;
}

static void put_short(unsigned char *bytes, unsigned short value)
{
	value = htons(value);
	memcpy(bytes, &value, sizeof(value));
}

static void put_long(unsigned char *bytes, uint32_t value)
{
	value = htonl(value);
	memcpy(bytes, &value, sizeof(value));
}

static int inject(unsigned long peer, unsigned char type, uint32_t connection,
	unsigned short source_port, unsigned short destination_port,
	const void *payload, int payload_length)
{
	unsigned char *frame = web_net_remote_ingress_buffer();

	frame[0] = 0x48;
	frame[1] = 1;
	frame[2] = type;
	frame[3] = 0;
	put_long(frame + 4, connection);
	put_short(frame + 8, source_port);
	put_short(frame + 10, destination_port);
	if (payload_length)
		memcpy(frame + 12, payload, (size_t)payload_length);
	return web_net_remote_receive(peer, 12 + payload_length);
}

static void test_local_loopback(void)
{
	const char message[] = "local datagram";
	char received[64];
	struct sockaddr_in destination = address(htonl(INADDR_LOOPBACK), 2302);
	int receiver = web_net_socket(AF_INET, SOCK_DGRAM, 0);
	int sender = web_net_socket(AF_INET, SOCK_DGRAM, 0);
	int source_length = sizeof(destination);

	assert(receiver >= 0 && sender >= 0);
	assert(web_net_bind(receiver, &destination, sizeof(destination)) == 0);
	assert(web_net_sendto(sender, message, sizeof(message), 0,
		&destination, sizeof(destination)) == (int)sizeof(message));
	assert(web_net_recvfrom(receiver, received, sizeof(received), 0,
		&destination, &source_length) == (int)sizeof(message));
	assert(!memcmp(received, message, sizeof(message)));
	assert(web_net_close(sender) == 0);
	assert(web_net_close(receiver) == 0);

	{
		struct sockaddr_in endpoint = address(htonl(INADDR_LOOPBACK), 2303);
		int listener = web_net_socket(AF_INET, SOCK_STREAM, 0);
		int client = web_net_socket(AF_INET, SOCK_STREAM, 0);
		int accepted;

		assert(web_net_bind(listener, &endpoint, sizeof(endpoint)) == 0);
		assert(web_net_listen(listener, 4) == 0);
		assert(web_net_connect(client, &endpoint, sizeof(endpoint)) == 0);
		accepted = web_net_accept(listener, NULL, NULL);
		assert(accepted >= 0);
		assert(web_net_send(client, message, sizeof(message), 0) == (int)sizeof(message));
		assert(web_net_recv(accepted, received, sizeof(received), 0) == (int)sizeof(message));
		assert(!memcmp(received, message, sizeof(message)));
		assert(web_net_close(client) == 0);
		assert(web_net_recv(accepted, received, sizeof(received), 0) == 0);
		assert(web_net_close(accepted) == 0);
		assert(web_net_close(listener) == 0);
	}
}

static unsigned long add_remote_peer(unsigned char identifier[6])
{
	unsigned char *ingress = web_net_remote_ingress_buffer();
	unsigned long peer;
	unsigned long lookup = 0;

	memcpy(ingress, identifier, 6);
	peer = web_net_remote_add_peer(ingress, 6);
	assert(peer != 0);
	assert(web_net_remote_set_peer_state(peer, 1, 1, 1) == 1);
	assert(web_net_peer_address(identifier, &lookup));
	assert(lookup == peer);
	return peer;
}

static void test_remote_datagrams(unsigned long peer)
{
	const char incoming[] = "from peer";
	const char outgoing[] = "to peer";
	char received[64];
	struct sockaddr_in local = address(htonl(INADDR_LOOPBACK), 2400);
	struct sockaddr_in remote = address(peer, 2401);
	struct sockaddr_in source;
	int source_length = sizeof(source);
	int receiver = web_net_socket(AF_INET, SOCK_DGRAM, 0);
	int sender = web_net_socket(AF_INET, SOCK_DGRAM, 0);
	int before = captured_count;

	assert(web_net_bind(receiver, &local, sizeof(local)) == 0);
	assert(inject(peer, 1, 0, 2401, 2400, incoming, sizeof(incoming)) == 1);
	assert(web_net_recvfrom(receiver, received, sizeof(received), 0,
		&source, &source_length) == (int)sizeof(incoming));
	assert(source.sin_addr.s_addr == peer && ntohs(source.sin_port) == 2401);
	assert(!memcmp(received, incoming, sizeof(incoming)));
	assert(web_net_sendto(sender, outgoing, sizeof(outgoing), 0,
		&remote, sizeof(remote)) == (int)sizeof(outgoing));
	assert(captured_count == before + 1);
	assert(captured[before].address == peer && !captured[before].reliable);
	assert(captured[before].bytes[2] == 1);
	assert(!memcmp(captured[before].bytes + 12, outgoing, sizeof(outgoing)));
	assert(web_net_close(sender) == 0);
	assert(web_net_close(receiver) == 0);
}

static void test_remote_streams(unsigned long peer)
{
	const char incoming[] = "remote stream data";
	const char outgoing[] = "stream reply";
	char received[64];
	struct sockaddr_in local = address(htonl(INADDR_LOOPBACK), 2500);
	struct sockaddr_in source;
	int source_length = sizeof(source);
	int listener = web_net_socket(AF_INET, SOCK_STREAM, 0);
	int accepted;
	int before;

	assert(web_net_bind(listener, &local, sizeof(local)) == 0);
	assert(web_net_listen(listener, 4) == 0);
	assert(inject(peer, 2, 0x12345678, 2501, 2500, NULL, 0) == 1);
	accepted = web_net_accept(listener, &source, &source_length);
	assert(accepted >= 0);
	assert(source.sin_addr.s_addr == peer && ntohs(source.sin_port) == 2501);
	assert(inject(peer, 3, 0x12345678, 0, 0,
		incoming, sizeof(incoming)) == 1);
	assert(web_net_recv(accepted, received, sizeof(received), 0) == (int)sizeof(incoming));
	assert(!memcmp(received, incoming, sizeof(incoming)));
	before = captured_count;
	assert(web_net_send(accepted, outgoing, sizeof(outgoing), 0) == (int)sizeof(outgoing));
	assert(captured_count == before + 1);
	assert(captured[before].reliable && captured[before].bytes[2] == 3);
	assert(!memcmp(captured[before].bytes + 12, outgoing, sizeof(outgoing)));
	assert(inject(peer, 4, 0x12345678, 0, 0, NULL, 0) == 1);
	assert(web_net_recv(accepted, received, sizeof(received), 0) == 0);
	assert(web_net_close(accepted) == 0);
	assert(web_net_close(listener) == 0);
}

static void test_backpressure_flush(unsigned long peer)
{
	struct sockaddr_in remote = address(peer, 2600);
	int socket = web_net_socket(AF_INET, SOCK_STREAM, 0);
	int before = captured_count;
	int write[1];
	int write_count = 1;

	assert(web_net_remote_set_peer_state(peer, 1, 0, 0) == 1);
	assert(web_net_connect(socket, &remote, sizeof(remote)) == 0);
	assert(captured_count == before);
	assert(web_net_remote_set_peer_state(peer, 1, 1, 1) == 1);
	write[0] = socket;
	assert(web_net_select(NULL, NULL, write, &write_count,
		NULL, NULL, 0, 0, 0) == 1);
	assert(captured_count == before + 1);
	assert(captured[before].reliable && captured[before].bytes[2] == 2);
	assert(web_net_close(socket) == 0);
}

int main(void)
{
	unsigned char remote_identifier[6] = { 2, 0, 0, 0, 0, 2 };
	unsigned long peer;

	test_local_loopback();
	peer = add_remote_peer(remote_identifier);
	test_remote_datagrams(peer);
	test_remote_streams(peer);
	test_backpressure_flush(peer);
	assert(web_net_remote_remove_peer(peer) == 1);
	puts("web_loopback_net tests passed");
	return 0;
}
