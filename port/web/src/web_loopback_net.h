/* Browser AF_INET sockets used by split-screen and WebRTC networking.

WasmFS deliberately leaves socket syscalls unimplemented, and browsers cannot
listen on TCP or UDP sockets in any case.  Halo still uses its normal network
protocol.  This module supplies local sockets behind the POSIX boundary and
maps remote WebRTC peers to addresses in 100.64.0.0/10.

The functions at the end of this file are the narrow bridge used by
library_web_transport.js.  Addresses and ports have the same network byte
order as sockaddr_in. */

#ifndef HALO_WEB_LOOPBACK_NET_H
#define HALO_WEB_LOOPBACK_NET_H

int web_net_socket(int family, int type, int protocol);
int web_net_close(int descriptor);
int web_net_bind(int descriptor, const void *address, int address_length);
int web_net_connect(int descriptor, const void *address, int address_length);
int web_net_listen(int descriptor, int backlog);
int web_net_accept(int descriptor, void *address, int *address_length);
int web_net_send(int descriptor, const void *buffer, int length, int flags);
int web_net_sendto(int descriptor, const void *buffer, int length, int flags,
	const void *address, int address_length);
int web_net_recv(int descriptor, void *buffer, int length, int flags);
int web_net_recvfrom(int descriptor, void *buffer, int length, int flags,
	void *address, int *address_length);
int web_net_shutdown(int descriptor, int how);
int web_net_set_nonblocking(int descriptor, int nonblocking);
int web_net_bytes_available(int descriptor, unsigned long *count);
int web_net_setsockopt(int descriptor, int level, int name, const void *value, int length);
int web_net_getsockopt(int descriptor, int level, int name, void *value, int *length);
int web_net_getsockname(int descriptor, void *address, int *address_length);
int web_net_getpeername(int descriptor, void *address, int *address_length);
int web_net_select(int *read, int *read_count, int *write, int *write_count,
	int *error, int *error_count, long timeout_seconds, long timeout_microseconds,
	int infinite);

/* A peer's six-byte XNADDR identifier maps to its browser-local virtual
address.  xnet.c uses this when resolving an advertised system-link game. */
int web_net_peer_address(const unsigned char *identifier, unsigned long *address);

/* WebRTC bridge exports.  The JavaScript adapter calls these through the
Emscripten Module object.  Mutating calls return zero when the socket lock is
temporarily busy, allowing JavaScript to retry without blocking the browser's
main thread. */
unsigned long web_net_remote_add_peer(const void *identifier, int identifier_length);
int web_net_remote_remove_peer(unsigned long address);
int web_net_remote_set_peer_state(unsigned long address, int connected,
	int reliable_writeable, int unreliable_writeable);
const void *web_net_remote_local_identifier(void);
void *web_net_remote_ingress_buffer(void);
int web_net_remote_ingress_capacity(void);
/* 1: consumed, 0: retry later, -1: malformed/fatal protocol input. */
int web_net_remote_receive(unsigned long address, int length);

#endif
