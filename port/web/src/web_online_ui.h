/* Browser invite-flow commands and game-side state.

The JavaScript shell runs on the browser thread while Halo runs on an
Emscripten pthread.  The exported functions in this header therefore only
touch atomics.  web_online_ui_update() consumes those values on Halo's game
thread and is the only entry point that changes menus or network state. */

#ifndef HALO_WEB_ONLINE_UI_H
#define HALO_WEB_ONLINE_UI_H

enum web_online_command
{
	_web_online_command_none = 0,
	_web_online_command_host,
	_web_online_command_join,
	_web_online_command_cancel,
};

enum web_online_multiplayer_level
{
	_web_online_multiplayer_level_battle_creek = 0,
	_web_online_multiplayer_level_sidewinder,
	_web_online_multiplayer_level_damnation,
	_web_online_multiplayer_level_rat_race,
	_web_online_multiplayer_level_prisoner,
	_web_online_multiplayer_level_hang_em_high,
	_web_online_multiplayer_level_chill_out,
	_web_online_multiplayer_level_derelict,
	_web_online_multiplayer_level_boarding_action,
	_web_online_multiplayer_level_blood_gulch,
	_web_online_multiplayer_level_wizard,
	_web_online_multiplayer_level_chiron_tl34,
	_web_online_multiplayer_level_longest,
	_web_online_multiplayer_level_count,
};

enum web_online_game_mode
{
	_web_online_game_mode_slayer = 0,
	_web_online_game_mode_team_slayer,
	_web_online_game_mode_ctf,
	_web_online_game_mode_oddball,
	_web_online_game_mode_king,
	_web_online_game_mode_race,
	_web_online_game_mode_count,
};

enum web_online_state
{
	_web_online_state_idle = 0,
	_web_online_state_waiting_for_main_menu,
	_web_online_state_host_starting,
	_web_online_state_hosting,
	_web_online_state_join_searching,
	_web_online_state_join_connecting,
	_web_online_state_joined,
	_web_online_state_error,
};

enum web_online_error
{
	_web_online_error_none = 0,
	_web_online_error_host_setup_failed,
	_web_online_error_client_setup_failed,
	_web_online_error_pregame_screen_failed,
	_web_online_error_join_failed,
	_web_online_error_join_timed_out,
};

enum web_online_transport_state
{
	_web_online_transport_disconnected = 0,
	_web_online_transport_connecting,
	_web_online_transport_connected,
	_web_online_transport_failed,
};

enum
{
	WEB_ONLINE_PLAYER_NAME_CHARACTERS = 11,
	WEB_ONLINE_PLAYER_COLOR_COUNT = 18,
};

/* JavaScript-facing, atomic-only API. */
int platform_web_online_request(int command);
int platform_web_online_host_configured(int map_index, int mode_index);
int platform_web_online_host_advanced_configured(
	int map_index,
	int mode_index,
	int score_to_win,
	int respawn_seconds,
	int lives,
	int health_percent,
	int rules);
void platform_web_set_player_magnetism_enabled(int enabled);
int platform_web_online_set_player_customization(
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
	int name10);
int platform_web_online_get_state(void);
int platform_web_online_get_error(void);
/* 0 while the match is in the lobby, 1 while it is in progress or on the scoreboard. */
int platform_web_online_get_match_phase(void);
void platform_web_online_set_transport_state(int state);
int platform_web_online_get_transport_state(void);

/* Called on Halo's game thread once per frame. */
void web_online_ui_update(int main_menu_loaded, float seconds);

#endif /* HALO_WEB_ONLINE_UI_H */
