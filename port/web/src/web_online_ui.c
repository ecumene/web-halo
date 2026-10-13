/* Browser invite-flow mailbox and game-thread menu integration. */

#include "web_online_ui.h"

#include <emscripten/emscripten.h>
#include <stdatomic.h>
#include <string.h>

/* This browser adapter is compiled as platform code, so it must not include
the game's cseries headers after the host libc headers.  Keep this boundary
to opaque pointers and the game's scalar ABI. */
struct network_game_client;
struct network_game_server;
struct widget_instance;

void ui_widgets_close_all(void);
struct widget_instance *ui_widget_load_by_name_or_tag(
	const char *name,
	long tag_index,
	struct widget_instance *parent,
	short local_player_index,
	long invoking_widget_tag,
	long focused_child_parent_widget_tag,
	short focused_child_index);
void dispose_global_network_game_server(void);
void dispose_global_network_game_client(void);
struct network_game_server *global_network_game_server_get(void);
struct network_game_client *global_network_game_client_get(void);
unsigned char create_global_network_game_client(void);
void network_game_accept_remote_connections(unsigned char accept_remote_connections);
void player_ui_clear_multiplayer_joins(void);
void player_ui_clear_multiplayer_variant(void);
void player_ui_fast_setup_network_server(void);
long player_ui_get_active_player_profile_index(short local_player_index);
void player_ui_get_active_player_profile(short local_player_index, void *profile);
void player_ui_set_active_player_profile(
	short local_player_index,
	long profile_index,
	void *profile);
unsigned char player_ui_configure_network_server_game(
	long multiplayer_level_index,
	long game_mode_index);
unsigned char player_ui_configure_network_server_game_advanced(
	long multiplayer_level_index,
	long game_mode_index,
	long score_to_win,
	long respawn_seconds,
	long lives,
	long health_percent,
	unsigned char infinite_grenades,
	unsigned char shields,
	unsigned char invisible_players,
	unsigned char other_players_on_radar);
void game_connection_set(short connection);
void main_goto_main_menu(void);
short network_game_client_get_state(struct network_game_client *client, short *state_data);
unsigned short network_game_server_get_state(struct network_game_server *server, short *substate);
short network_game_client_get_error(struct network_game_client *client);
unsigned char network_game_client_join_first_available_game(void);
unsigned char network_game_client_add_player(struct network_game_client *client, short controller_index);
unsigned char network_game_client_has_local_player(
	struct network_game_client *client,
	short local_player_index);
void platform_log(const char *format, ...);

enum
{
	/* network_game_client_get_state(), kept private by its implementation */
	_network_client_searching = 0,
	_network_client_joining,
	_network_client_pregame,
	_network_client_ingame,
	_network_client_postgame,

	/* Native invite joining also gives up after 90 seconds. */
	WEB_ONLINE_JOIN_TIMEOUT_SECONDS = 90,
	/* Retry slowly enough to avoid duplicate in-game queue entries, but soon
	 * enough to recover when a pregame add crosses the match transition. */
	WEB_ONLINE_PLAYER_RETRY_SECONDS = 1,

	_game_connection_local = 0,
	_game_connection_network_client,

	WEB_ONLINE_REQUEST_COMMAND_MASK = 0xff,
	WEB_ONLINE_REQUEST_MAP_SHIFT = 8,
	WEB_ONLINE_REQUEST_MODE_SHIFT = 16,
	WEB_ONLINE_REQUEST_ADVANCED_BIT = 1 << 24,

	WEB_ONLINE_RULE_INFINITE_GRENADES_BIT = 0,
	WEB_ONLINE_RULE_SHIELDS_BIT,
	WEB_ONLINE_RULE_INVISIBLE_PLAYERS_BIT,
	WEB_ONLINE_RULE_OTHER_PLAYERS_ON_RADAR_BIT,
	WEB_ONLINE_RULE_MASK = 0xf,
};

#define WEB_FALSE ((unsigned char)0)
#define WEB_TRUE 1
#define WEB_NONE (-1)

/* Xbox player profiles use eleven UTF-16 code units plus a terminator.  Keep
 * this small ABI mirror local to the browser adapter: including the game's
 * cseries headers after Emscripten's host headers would corrupt libc types. */
struct web_online_player_profile
{
	unsigned short player_name[WEB_ONLINE_PLAYER_NAME_CHARACTERS + 1];
	short primary_color_index;
	unsigned char remainder[22];
};

_Static_assert(sizeof(struct web_online_player_profile) == 0x30,
	"web player profile ABI must remain 0x30 bytes");

/* Command and host options share one atomic word so the game thread can never
observe a new command with map/mode values from a different browser request. */
static atomic_int web_online_requested_request = ATOMIC_VAR_INIT(_web_online_command_none);
static atomic_int web_online_requested_score_to_win = ATOMIC_VAR_INIT(15);
static atomic_int web_online_requested_respawn_seconds = ATOMIC_VAR_INIT(0);
static atomic_int web_online_requested_lives = ATOMIC_VAR_INIT(0);
static atomic_int web_online_requested_health_percent = ATOMIC_VAR_INIT(100);
static atomic_int web_online_requested_rules = ATOMIC_VAR_INIT(0xa);
static atomic_int web_online_requested_player_magnetism = ATOMIC_VAR_INIT(1);
static atomic_int web_online_public_state = ATOMIC_VAR_INIT(_web_online_state_idle);
static atomic_int web_online_match_phase = ATOMIC_VAR_INIT(0);
static atomic_int web_online_public_error = ATOMIC_VAR_INIT(_web_online_error_none);
static atomic_int web_online_transport_state = ATOMIC_VAR_INIT(_web_online_transport_disconnected);
static atomic_uint web_online_customization_sequence = ATOMIC_VAR_INIT(0);
static atomic_int web_online_requested_color = ATOMIC_VAR_INIT(0);
static atomic_int web_online_requested_name[WEB_ONLINE_PLAYER_NAME_CHARACTERS];
static unsigned int web_online_applied_customization_sequence;

static struct
{
	int command;
	int setup;
	int join_attempted;
	int join_completed;
	int player_added;
	int player_request_sent;
	int pregame_screen_loaded;
	int wait_frames;
	int host_map_index;
	int host_mode_index;
	int host_advanced_settings;
	int host_score_to_win;
	int host_respawn_seconds;
	int host_lives;
	int host_health_percent;
	int host_rules;
	float seconds;
	float player_retry_seconds;
} web_online;

static void publish_state(int state)
{
	atomic_store_explicit(&web_online_public_state, state, memory_order_release);
}

static void publish_match_phase(int live)
{
	atomic_store_explicit(&web_online_match_phase, live ? 1 : 0, memory_order_release);
}

static void publish_error(int error)
{
	atomic_store_explicit(&web_online_public_error, error, memory_order_release);
}

static int pack_request(int command, int map_index, int mode_index)
{
	return (command & WEB_ONLINE_REQUEST_COMMAND_MASK) |
		(map_index << WEB_ONLINE_REQUEST_MAP_SHIFT) |
		(mode_index << WEB_ONLINE_REQUEST_MODE_SHIFT);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_request(int command)
{
	if (command < _web_online_command_host || command > _web_online_command_cancel)
		return 0;
	/* Legacy callers that only request hosting get the safe defaults: Battle
	Creek and Slayer. Join/cancel ignore the packed host fields. */
	atomic_store_explicit(
		&web_online_requested_request,
		pack_request(command, 0, 0),
		memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_host_configured(
	int map_index,
	int mode_index)
{
	if (map_index < 0 || map_index >= _web_online_multiplayer_level_count ||
		mode_index < 0 || mode_index >= _web_online_game_mode_count)
	{
		return 0;
	}
	atomic_store_explicit(
		&web_online_requested_request,
		pack_request(_web_online_command_host, map_index, mode_index),
		memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_host_advanced_configured(
	int map_index,
	int mode_index,
	int score_to_win,
	int respawn_seconds,
	int lives,
	int health_percent,
	int rules)
{
	if (map_index < 0 || map_index >= _web_online_multiplayer_level_count ||
		mode_index < 0 || mode_index >= _web_online_game_mode_count ||
		score_to_win < 1 || score_to_win > 1000 ||
		respawn_seconds < 0 || respawn_seconds > 30 ||
		lives < 0 || lives > 99 ||
		health_percent < 25 || health_percent > 400 ||
		(rules & ~WEB_ONLINE_RULE_MASK))
	{
		return 0;
	}

	/* Publish the rules first, then release the request containing the advanced
	bit. The game thread acquires that request before reading this mailbox. */
	atomic_store_explicit(&web_online_requested_score_to_win, score_to_win, memory_order_relaxed);
	atomic_store_explicit(&web_online_requested_respawn_seconds, respawn_seconds, memory_order_relaxed);
	atomic_store_explicit(&web_online_requested_lives, lives, memory_order_relaxed);
	atomic_store_explicit(&web_online_requested_health_percent, health_percent, memory_order_relaxed);
	atomic_store_explicit(&web_online_requested_rules, rules, memory_order_relaxed);
	atomic_store_explicit(
		&web_online_requested_request,
		pack_request(_web_online_command_host, map_index, mode_index) |
			WEB_ONLINE_REQUEST_ADVANCED_BIT,
		memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE void platform_web_set_player_magnetism_enabled(int enabled)
{
	atomic_store_explicit(
		&web_online_requested_player_magnetism,
		!!enabled,
		memory_order_release);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_set_player_customization(
	int color_index,
	int name0,
	int name1,
	int name2,
	int name3,
	int name4,
	int name5,
	int name6,
	int name7,
	int name8,
	int name9,
	int name10)
{
	int i;
	int name_length = 0;
	int name[WEB_ONLINE_PLAYER_NAME_CHARACTERS] =
	{
		name0, name1, name2, name3, name4, name5,
		name6, name7, name8, name9, name10,
	};

	if (color_index < 0 || color_index >= WEB_ONLINE_PLAYER_COLOR_COUNT)
		return 0;

	/* Browser names intentionally use Halo's portable ASCII subset.  Reject a
	 * malformed caller instead of letting control codes reach menu rendering. */
	for (i = 0; i < WEB_ONLINE_PLAYER_NAME_CHARACTERS; i++)
	{
		if (!name[i])
			break;
		if (name[i] < 0x20 || name[i] > 0x7e)
			return 0;
		name_length++;
	}
	if (!name_length)
		return 0;

	/* Odd versions are writes in progress; even versions are complete. */
	atomic_fetch_add_explicit(
		&web_online_customization_sequence,
		1,
		memory_order_acq_rel);
	atomic_store_explicit(
		&web_online_requested_color,
		color_index,
		memory_order_relaxed);
	for (i = 0; i < WEB_ONLINE_PLAYER_NAME_CHARACTERS; i++)
	{
		atomic_store_explicit(
			&web_online_requested_name[i],
			i < name_length ? name[i] : 0,
			memory_order_relaxed);
	}
	/* Publishing the even version last commits the mailbox transaction. */
	atomic_fetch_add_explicit(
		&web_online_customization_sequence,
		1,
		memory_order_release);
	return 1;
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_state(void)
{
	return atomic_load_explicit(&web_online_public_state, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_match_phase(void)
{
	return atomic_load_explicit(&web_online_match_phase, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_error(void)
{
	return atomic_load_explicit(&web_online_public_error, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE void platform_web_online_set_transport_state(int state)
{
	if (state < _web_online_transport_disconnected || state > _web_online_transport_failed)
		return;
	atomic_store_explicit(&web_online_transport_state, state, memory_order_release);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_transport_state(void)
{
	return atomic_load_explicit(&web_online_transport_state, memory_order_acquire);
}

EMSCRIPTEN_KEEPALIVE int platform_web_online_get_client_state(void)
{
	struct network_game_client *client = global_network_game_client_get();

	return client ? network_game_client_get_state(client, NULL) : WEB_NONE;
}

static void apply_requested_player_customization(void)
{
	int i;
	unsigned int sequence;
	unsigned int committed_sequence;
	struct web_online_player_profile profile;

	sequence = atomic_load_explicit(
		&web_online_customization_sequence,
		memory_order_acquire);
	if ((sequence & 1) || sequence == web_online_applied_customization_sequence)
		return;

	player_ui_get_active_player_profile(0, &profile);
	for (i = 0; i < WEB_ONLINE_PLAYER_NAME_CHARACTERS; i++)
	{
		profile.player_name[i] = (unsigned short)atomic_load_explicit(
			&web_online_requested_name[i],
			memory_order_relaxed);
	}
	profile.player_name[WEB_ONLINE_PLAYER_NAME_CHARACTERS] = 0;
	profile.primary_color_index = (short)atomic_load_explicit(
		&web_online_requested_color,
		memory_order_relaxed);
	committed_sequence = atomic_load_explicit(
		&web_online_customization_sequence,
		memory_order_acquire);
	if (sequence != committed_sequence)
		return;
	player_ui_set_active_player_profile(
		0,
		player_ui_get_active_player_profile_index(0),
		&profile);
	web_online_applied_customization_sequence = sequence;
}

static void clear_multiplayer_joins_and_restore_customization(void)
{
	/* Halo's stock clear also replaces every active player profile with an
	 * unnamed, colour-less default.  Browser hosting/joining deliberately
	 * bypasses the profile picker, so restore the identity the browser posted
	 * before network_game_client_add_player() serializes that profile.  Without
	 * this, the server sees an empty name/NONE colour and assigns random values
	 * such as "Howard" instead. */
	player_ui_clear_multiplayer_joins();
	web_online_applied_customization_sequence = 0;
	apply_requested_player_customization();
}

static void reset_owned_game(void)
{
	/* This mirrors the stock network-game cancel handlers.  Closing the old
	widgets first prevents them from observing the disposed client/server on
	the remainder of this frame. */
	ui_widgets_close_all();
	dispose_global_network_game_server();
	dispose_global_network_game_client();
	network_game_accept_remote_connections(WEB_FALSE);
	player_ui_clear_multiplayer_joins();
	player_ui_clear_multiplayer_variant();
	game_connection_set(_game_connection_local);
	main_goto_main_menu();
}

static void clear_session(void)
{
	memset(&web_online, 0, sizeof(web_online));
	publish_match_phase(0);
}

static void fail_session(int error)
{
	platform_log("web online: session failed (%d)", error);
	if (web_online.setup)
		reset_owned_game();
	clear_session();
	publish_error(error);
	publish_state(_web_online_state_error);
}

static void begin_request(
	int command,
	int map_index,
	int mode_index,
	int advanced_settings)
{
	platform_log("web online: request %s", command == _web_online_command_host ? "host" : "join");
	if (web_online.command || web_online.setup)
	{
		reset_owned_game();
		clear_session();
		/* main_menu_load() runs near the beginning of the next frame. */
		web_online.wait_frames = 1;
	}
	web_online.command = command;
	web_online.host_map_index = map_index;
	web_online.host_mode_index = mode_index;
	web_online.host_advanced_settings = advanced_settings;
	if (advanced_settings)
	{
		web_online.host_score_to_win = atomic_load_explicit(
			&web_online_requested_score_to_win, memory_order_relaxed);
		web_online.host_respawn_seconds = atomic_load_explicit(
			&web_online_requested_respawn_seconds, memory_order_relaxed);
		web_online.host_lives = atomic_load_explicit(
			&web_online_requested_lives, memory_order_relaxed);
		web_online.host_health_percent = atomic_load_explicit(
			&web_online_requested_health_percent, memory_order_relaxed);
		web_online.host_rules = atomic_load_explicit(
			&web_online_requested_rules, memory_order_relaxed);
	}
	publish_error(_web_online_error_none);
	publish_state(_web_online_state_waiting_for_main_menu);
}

static void cancel_request(void)
{
	if (web_online.command || web_online.setup)
		reset_owned_game();
	clear_session();
	publish_error(_web_online_error_none);
	publish_state(_web_online_state_idle);
}

static void setup_host(void)
{
	platform_log("web online: opening host lobby");
	clear_multiplayer_joins_and_restore_customization();
	player_ui_clear_multiplayer_variant();
	publish_state(_web_online_state_host_starting);
	player_ui_fast_setup_network_server();
	web_online.setup = WEB_TRUE;
	if (!global_network_game_server_get() || !global_network_game_client_get())
	{
		fail_session(_web_online_error_host_setup_failed);
		return;
	}
	if (web_online.host_advanced_settings ?
		!player_ui_configure_network_server_game_advanced(
			web_online.host_map_index,
			web_online.host_mode_index,
			web_online.host_score_to_win,
			web_online.host_respawn_seconds,
			web_online.host_lives,
			web_online.host_health_percent,
			(web_online.host_rules & (1 << WEB_ONLINE_RULE_INFINITE_GRENADES_BIT)) != 0,
			(web_online.host_rules & (1 << WEB_ONLINE_RULE_SHIELDS_BIT)) != 0,
			(web_online.host_rules & (1 << WEB_ONLINE_RULE_INVISIBLE_PLAYERS_BIT)) != 0,
			(web_online.host_rules & (1 << WEB_ONLINE_RULE_OTHER_PLAYERS_ON_RADAR_BIT)) != 0) :
		!player_ui_configure_network_server_game(
			web_online.host_map_index,
			web_online.host_mode_index))
	{
		fail_session(_web_online_error_host_setup_failed);
		return;
	}
	platform_log("web online: host lobby ready");
	publish_state(_web_online_state_hosting);
}

static void setup_join(void)
{
	platform_log("web online: opening join client");
	dispose_global_network_game_client();
	dispose_global_network_game_server();
	network_game_accept_remote_connections(WEB_FALSE);
	clear_multiplayer_joins_and_restore_customization();
	player_ui_clear_multiplayer_variant();
	web_online.setup = WEB_TRUE;
	if (!create_global_network_game_client())
	{
		fail_session(_web_online_error_client_setup_failed);
		return;
	}
	game_connection_set(_game_connection_network_client);
	publish_state(_web_online_state_join_searching);
}

static void add_primary_player_when_ready(
	struct network_game_client *client,
	float seconds)
{
	if (!client || web_online.player_added)
		return;
	if (network_game_client_has_local_player(client, 0))
	{
		web_online.player_added = WEB_TRUE;
		platform_log("web online: primary player confirmed");
		return;
	}

	web_online.player_retry_seconds += seconds;
	if (!web_online.player_request_sent ||
		web_online.player_retry_seconds >= WEB_ONLINE_PLAYER_RETRY_SECONDS)
	{
		if (network_game_client_add_player(client, 0))
		{
			platform_log("web online: %s primary player",
				web_online.player_request_sent ? "retrying" : "requesting");
			web_online.player_request_sent = WEB_TRUE;
		}
		web_online.player_retry_seconds = 0.0f;
	}
}

static void update_host(float seconds)
{
	struct network_game_client *client = global_network_game_client_get();

	if (!global_network_game_server_get() || !client)
	{
		/* Backing out through Halo's own UI ends the browser room cleanly. */
		clear_session();
		publish_error(_web_online_error_none);
		publish_state(_web_online_state_idle);
		return;
	}
	web_online.seconds += seconds;
	if (web_online.seconds >= 0.5f)
		add_primary_player_when_ready(client, seconds);
	{
		struct network_game_server *server = global_network_game_server_get();
		unsigned short server_state = server ?
			network_game_server_get_state(server, NULL) : 0;
		/* Pregame stays open. In-game and the scoreboard hold newcomers until
		 * the next lobby so a live match is not joined mid-round. */
		publish_match_phase(server_state == 1 || server_state == 2);
	}
	publish_state(_web_online_state_hosting);
}

static int load_join_pregame_screen(void)
{
	ui_widgets_close_all();
	return ui_widget_load_by_name_or_tag(
		"ui\\shell\\main_menu\\multiplayer_type_select\\connected\\pregame\\connected_pregame_screen",
		WEB_NONE, NULL, WEB_NONE, WEB_NONE, WEB_NONE, WEB_NONE) != NULL;
}

static void update_join(float seconds)
{
	struct network_game_client *client = global_network_game_client_get();
	short client_state;

	web_online.seconds += seconds;
	if (web_online.seconds >= WEB_ONLINE_JOIN_TIMEOUT_SECONDS && !web_online.join_completed)
	{
		fail_session(_web_online_error_join_timed_out);
		return;
	}
	if (!client)
	{
		/* Halo's Back action disposes the client before the browser receives a
		 * cancel command. Treat that local UI action as a clean room exit. */
		clear_session();
		publish_error(_web_online_error_none);
		publish_state(_web_online_state_idle);
		return;
	}
	if (network_game_client_get_error(client) != 0)
	{
		fail_session(_web_online_error_join_failed);
		return;
	}

	client_state = network_game_client_get_state(client, NULL);
	if (!web_online.join_attempted && client_state == _network_client_searching)
	{
		if (network_game_client_join_first_available_game())
		{
			web_online.join_attempted = WEB_TRUE;
			if (!load_join_pregame_screen())
			{
				fail_session(_web_online_error_pregame_screen_failed);
				return;
			}
			web_online.pregame_screen_loaded = WEB_TRUE;
			publish_state(_web_online_state_join_connecting);
		}
		else
		{
			publish_state(_web_online_state_join_searching);
		}
		return;
	}

	if (client_state == _network_client_joining)
	{
		publish_state(_web_online_state_join_connecting);
		return;
	}
	if (client_state == _network_client_pregame ||
		client_state == _network_client_ingame ||
		client_state == _network_client_postgame)
	{
		add_primary_player_when_ready(client, seconds);
		if (!web_online.player_added)
		{
			publish_state(_web_online_state_join_connecting);
			return;
		}
		web_online.join_completed = WEB_TRUE;
		if (!web_online.pregame_screen_loaded && client_state == _network_client_pregame)
		{
			if (!load_join_pregame_screen())
			{
				fail_session(_web_online_error_pregame_screen_failed);
				return;
			}
			web_online.pregame_screen_loaded = WEB_TRUE;
		}
		publish_state(_web_online_state_joined);
		return;
	}

	/* A rejected or disconnected join returns the client to searching. */
	if (web_online.join_attempted && client_state == _network_client_searching)
		fail_session(_web_online_error_join_failed);
}

void web_online_ui_update(int main_menu_loaded, float seconds)
{
	extern unsigned char player_magnetism_flag;
	int request = atomic_exchange_explicit(
		&web_online_requested_request,
		_web_online_command_none,
		memory_order_acq_rel);
	int command = request & WEB_ONLINE_REQUEST_COMMAND_MASK;
	int map_index = (request >> WEB_ONLINE_REQUEST_MAP_SHIFT) & 0xff;
	int mode_index = (request >> WEB_ONLINE_REQUEST_MODE_SHIFT) & 0xff;
	int advanced_settings = (request & WEB_ONLINE_REQUEST_ADVANCED_BIT) != 0;

	player_magnetism_flag = (unsigned char)atomic_load_explicit(
		&web_online_requested_player_magnetism,
		memory_order_acquire);

	/* Browser calls only publish atomics.  Apply the selected identity here,
	 * before host/join can build its network_player from the active profile. */
	apply_requested_player_customization();

	if (command == _web_online_command_cancel)
	{
		cancel_request();
		return;
	}
	if (command == _web_online_command_host || command == _web_online_command_join)
		begin_request(command, map_index, mode_index, advanced_settings);

	if (!web_online.command)
		return;
	if (web_online.wait_frames > 0)
	{
		web_online.wait_frames--;
		return;
	}
	if (!web_online.setup)
	{
		if (!main_menu_loaded)
		{
			publish_state(_web_online_state_waiting_for_main_menu);
			return;
		}
		if (web_online.command == _web_online_command_host)
			setup_host();
		else
			setup_join();
		return;
	}

	if (web_online.command == _web_online_command_host)
		update_host(seconds);
	else
		update_join(seconds);
}
