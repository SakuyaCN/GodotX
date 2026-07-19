extends SceneTree

const DockContent := preload("res://addons/godetx/godetx_dock.gd")
const Localization := preload("res://addons/godetx/localization.gd")


func _init() -> void:
	Localization.install_for_locale("en_US")
	var dock := DockContent.new()
	dock._build_ui()
	var adaptive_loop_config := not dock._build_runtime_config().has("max_steps")
	var defaults_to_ask := (
		not dock._should_auto_approve("file_change")
		and not dock._should_auto_approve("command")
		and not dock._should_auto_approve("editor_game")
		and dock._selected_approval_mode() == dock.APPROVAL_MODE_ASK
		and not dock._runtime_automation_enabled
		and not dock._runtime_automation.button_pressed
	)
	var settings_are_separate: bool = (
		dock._settings_dialog.is_ancestor_of(dock._settings_provider_select)
		and dock._settings_dialog.is_ancestor_of(dock._settings_base_url)
		and dock._settings_dialog.is_ancestor_of(dock._settings_api_key)
		and dock._settings_dialog.is_ancestor_of(dock._runtime_automation)
		and dock._settings_api_key.secret
		and dock._remember_api_key.button_pressed
		and dock._settings_config_controls.has("api_mode")
	)
	var uses_dropdowns: bool = (
		dock._settings_provider_select is OptionButton
		and str(dock._settings_provider_select.get_item_metadata(0)) == dock.DEFAULT_PROVIDER
		and dock._settings_provider_select.auto_translate_mode == Node.AUTO_TRANSLATE_MODE_DISABLED
		and dock._model_select.auto_translate_mode == Node.AUTO_TRANSLATE_MODE_DISABLED
		and dock._model_select is OptionButton
		and dock._reasoning_select is OptionButton
		and dock._approval_mode_select is OptionButton
		and dock._approval_mode_select.item_count == 2
		and dock._model_select.clip_text
		and dock._reasoning_select.auto_translate_mode == Node.AUTO_TRANSLATE_MODE_DISABLED
		and not dock._reasoning_select.visible
		and dock._selected_reasoning().is_empty()
	)
	dock._auto_approve_edits.button_pressed = true
	dock._runtime_automation.button_pressed = true
	var draft_does_not_apply := (
		not dock._should_auto_approve("file_change")
		and not dock._runtime_automation_enabled
	)
	dock._settings_base_url.text = "https://example.test/v1/"
	dock._settings_api_key.text = "test-key"
	dock._apply_settings()
	var settings_applied: bool = (
		dock._base_url_value == "https://example.test/v1"
		and dock._api_key_value == "test-key"
		and dock._auto_approve_edits_enabled
		and dock._runtime_automation_enabled
		and dock._runtime_automation.button_pressed
		and dock._selected_approval_mode() == dock.APPROVAL_MODE_AUTO_EDITS
	)
	dock._auto_approve_edits.button_pressed = false
	dock._runtime_automation.button_pressed = false
	var unconfirmed_draft_is_ignored := (
		dock._should_auto_approve("file_change")
		and dock._runtime_automation_enabled
		and dock._selected_approval_mode() == dock.APPROVAL_MODE_AUTO_EDITS
	)
	# Opening settings restores both controls from their last applied values.
	dock._auto_approve_edits.button_pressed = dock._auto_approve_edits_enabled
	dock._runtime_automation.button_pressed = dock._runtime_automation_enabled
	dock._approval_mode_select.select(0)
	dock._on_approval_mode_selected(0)
	var composer_can_request_approval: bool = (
		not dock._auto_approve_edits_enabled
		and not dock._auto_approve_edits.button_pressed
		and dock._selected_approval_mode() == dock.APPROVAL_MODE_ASK
		and not dock._should_auto_approve("file_change")
	)
	dock._approval_mode_select.select(1)
	dock._on_approval_mode_selected(1)
	var composer_can_approve_for_user: bool = (
		dock._auto_approve_edits_enabled
		and dock._auto_approve_edits.button_pressed
		and dock._selected_approval_mode() == dock.APPROVAL_MODE_AUTO_EDITS
		and dock._should_auto_approve("file_change")
		and dock._should_auto_approve("command")
		and dock._should_auto_approve("editor_game")
	)
	var auto_approval_copy_is_clear: bool = (
		dock._format_tool_arguments("game_debug_start", {
			"mode": "current",
			"scene_path": "/",
		}).contains("Game launch will be approved automatically.")
		and dock._format_tool_arguments("game_debug_start", {
			"mode": "current",
			"scene_path": "/",
		}).contains("Supplied scene path ignored")
		and not dock._format_tool_arguments("game_debug_start", {
			"mode": "current",
			"scene_path": "/",
		}).contains("Scene: /")
	)
	dock._turn_in_progress = true
	dock._update_controls()
	dock._approval_mode_select.select(0)
	dock._on_approval_mode_selected(0)
	var running_mode_is_frozen: bool = (
		dock._approval_mode_select.disabled
		and dock._selected_approval_mode() == dock.APPROVAL_MODE_AUTO_EDITS
		and dock._approval_mode_select.selected == 1
	)
	dock._turn_in_progress = false
	dock._update_controls()
	dock._populate_models([
		{
			"id": "another-model",
			"capabilities": {
				"reasoning": {"efforts": ["none", "deep"], "default_effort": "none"},
			},
		},
		{
			"id": dock.DEFAULT_MODEL,
			"capabilities": {
				"reasoning": {
					"efforts": ["low", "medium", "high", "xhigh", "max"],
					"default_effort": "low",
				},
			},
		},
	])
	var default_model_selected := dock._selected_model() == dock.DEFAULT_MODEL
	var expected_default_model := dock.DEFAULT_MODEL == "gpt-5.6-sol"
	var default_reasoning_values: Array[String] = []
	for index in dock._reasoning_select.item_count:
		default_reasoning_values.append(str(dock._reasoning_select.get_item_metadata(index)))
	var default_reasoning_uses_capabilities := (
		default_reasoning_values == ["low", "medium", "high", "xhigh", "max"]
		and dock._selected_reasoning() == "low"
	)
	dock._reasoning_select.select(4)
	var sol_offers_max := dock._selected_reasoning() == "max"
	dock._models_ready = true
	dock._configured_fingerprint = dock._connection_fingerprint()
	dock._settings_base_url.text = dock._base_url_value
	dock._settings_api_key.text = dock._api_key_value
	dock._auto_approve_edits.button_pressed = true
	dock._apply_settings()
	var unchanged_connection_does_not_sync := dock._models_ready and not dock._model_sync_in_flight
	dock._remember_api_key.button_pressed = false
	dock._apply_settings()
	var remember_opt_out_keeps_session_key: bool = (
		not dock._remember_api_key_enabled
		and dock._api_key_value == "test-key"
		and dock._models_ready
		and not dock._model_sync_in_flight
	)
	var long_model_id := "model-%s" % "x".repeat(100)
	dock._populate_models([{
		"id": long_model_id,
		"capabilities": {
			"reasoning": {"efforts": ["minimal", "deep"], "default_effort": "deep"},
		},
	}])
	var long_model_is_clipped: bool = (
		dock._selected_model() == long_model_id
		and dock._model_select.get_item_text(0).length() <= dock.MODEL_LABEL_MAX_LENGTH
	)
	var provider_specific_reasoning: bool = (
		dock._reasoning_select.item_count == 2
		and dock._selected_reasoning() == "deep"
	)
	dock._model_sync_in_flight = true
	dock._update_controls()
	var settings_lock_during_sync: bool = (
		dock._settings_dialog.get_ok_button().disabled
		and not dock._settings_base_url.editable
		and not dock._settings_api_key.editable
		and dock._runtime_automation.disabled
	)
	dock._model_sync_in_flight = false
	dock._update_controls()
	var runtime_toggle_unlocks := not dock._runtime_automation.disabled
	var secure_url_policy: bool = (
		dock._is_loopback_http_url("http://127.0.0.1:32145/v1")
		and not dock._is_loopback_http_url("http://models.example/v1")
		and dock._base_url_has_credentials("https://user:pass@models.example/v1")
	)
	var platform_path_scoping: bool = (
		dock._normalize_workspace_identity("C:\\Work\\Game", "Windows")
			== dock._normalize_workspace_identity("c:/work/game/", "Windows")
		and dock._normalize_workspace_identity("/work/Game", "Linux")
			!= dock._normalize_workspace_identity("/work/game", "Linux")
	)
	dock._message_had_delta = true
	dock._delta_buffer = "partial"
	dock._reset_message_stream()
	var stream_state_resets := not dock._message_had_delta and dock._delta_buffer.is_empty()
	dock._populate_models([{
		"id": "capability-model",
		"capabilities": {
			"reasoning": {
				"efforts": ["low", "high"],
				"default_effort": "high",
			},
		},
	}])
	var capability_reasoning_values: Array[String] = []
	for index in dock._reasoning_select.item_count:
		capability_reasoning_values.append(str(dock._reasoning_select.get_item_metadata(index)))
	var reasoning_uses_capabilities: bool = (
		capability_reasoning_values == ["low", "high"]
		and dock._selected_reasoning() == "high"
	)
	var dynamic_providers := dock._populate_providers([
		{
			"id": dock.DEFAULT_PROVIDER,
			"display_name": "OpenAI compatible",
			"default_model": dock.DEFAULT_MODEL,
			"config_fields": [
				{"key": "base_url", "label": "Base URL", "type": "url", "required": true},
				{"key": "api_key", "label": "API key", "type": "secret", "required": true},
			],
		},
		{
			"id": "deepseek",
			"display_name": "DeepSeek",
			"default_model": "deepseek-v4-flash",
			"config_fields": [
				{"key": "api_key", "label": "API key", "type": "secret", "required": true},
			],
		},
		{
			"id": "opencode-zen",
			"display_name": "OpenCode Zen",
			"default_model": "gpt-5.6-sol",
			"config_fields": [
				{"key": "api_key", "label": "API key", "type": "secret", "required": true},
			],
		},
		{
			"id": "local-test",
			"display_name": "Local test",
			"default_model": "local-model",
			"config_fields": [
				{"key": "endpoint", "label": "Endpoint", "type": "url", "required": true, "default_value": "http://127.0.0.1:9000"},
				{"key": "profile", "label": "Profile", "type": "select", "required": true, "options": [{"value": "fast", "label": "Fast"}]},
			],
		},
	])
	var deepseek_provider_index := -1
	var zen_provider_index := -1
	var local_provider_index := -1
	for index in dock._settings_provider_select.item_count:
		var provider_id := str(dock._settings_provider_select.get_item_metadata(index))
		if provider_id == "deepseek":
			deepseek_provider_index = index
		elif provider_id == "opencode-zen":
			zen_provider_index = index
		elif provider_id == "local-test":
			local_provider_index = index
	dock._on_settings_provider_selected(deepseek_provider_index)
	var deepseek_api_key = dock._settings_config_controls.get("api_key")
	var deepseek_settings_are_isolated: bool = (
		deepseek_provider_index >= 0
		and deepseek_api_key is LineEdit
		and (deepseek_api_key as LineEdit).secret
		and dock._settings_config_controls.size() == 1
		and not dock._settings_config_controls.has("base_url")
	)
	if deepseek_api_key is LineEdit:
		(deepseek_api_key as LineEdit).text = "deepseek-test-key"
	dock._on_settings_provider_selected(zen_provider_index)
	var zen_api_key = dock._settings_config_controls.get("api_key")
	var zen_settings_are_isolated: bool = (
		zen_provider_index >= 0
		and zen_api_key is LineEdit
		and (zen_api_key as LineEdit).secret
		and (zen_api_key as LineEdit).text.is_empty()
		and dock._settings_config_controls.size() == 1
		and not dock._settings_config_controls.has("base_url")
		and str((dock._settings_provider_drafts.get("deepseek", {}) as Dictionary).get("api_key", ""))
			== "deepseek-test-key"
	)
	if zen_api_key is LineEdit:
		(zen_api_key as LineEdit).text = "zen-test-key"
	dock._on_settings_provider_selected(local_provider_index)
	deepseek_settings_are_isolated = (
		deepseek_settings_are_isolated
		and str((dock._settings_provider_drafts.get("deepseek", {}) as Dictionary).get("api_key", ""))
			== "deepseek-test-key"
		and not dock._settings_config_controls.has("api_key")
	)
	zen_settings_are_isolated = (
		zen_settings_are_isolated
		and str((dock._settings_provider_drafts.get("opencode-zen", {}) as Dictionary).get("api_key", ""))
			== "zen-test-key"
		and not dock._settings_config_controls.has("api_key")
	)
	dock._on_settings_provider_selected(deepseek_provider_index)
	var restored_deepseek_key = dock._settings_config_controls.get("api_key")
	deepseek_settings_are_isolated = (
		deepseek_settings_are_isolated
		and restored_deepseek_key is LineEdit
		and (restored_deepseek_key as LineEdit).text == "deepseek-test-key"
	)
	dock._on_settings_provider_selected(zen_provider_index)
	var restored_zen_key = dock._settings_config_controls.get("api_key")
	zen_settings_are_isolated = (
		zen_settings_are_isolated
		and restored_zen_key is LineEdit
		and (restored_zen_key as LineEdit).text == "zen-test-key"
	)
	dock._model_capabilities["stale-openai-model"] = {"reasoning": {"efforts": ["max"]}}
	dock._models_ready = true
	dock._apply_settings()
	var zen_runtime_config := dock._build_runtime_config()
	var zen_runtime_config_is_exact: bool = (
		dock._provider_id == "opencode-zen"
		and zen_runtime_config.get("provider_id") == "opencode-zen"
		and zen_runtime_config.get("provider_config") == {"api_key": "zen-test-key"}
		and zen_runtime_config.get("model") == "gpt-5.6-sol"
		and not zen_runtime_config.has("base_url")
		and dock._model_capabilities.is_empty()
		and not dock._models_ready
	)
	var provider_setting_prefixes := [
		dock._provider_settings_prefix("godetx/test", dock.DEFAULT_PROVIDER),
		dock._provider_settings_prefix("godetx/test", "deepseek"),
		dock._provider_settings_prefix("godetx/test", "opencode-zen"),
	]
	var provider_setting_prefixes_are_isolated: bool = (
		provider_setting_prefixes[0] != provider_setting_prefixes[1]
		and provider_setting_prefixes[0] != provider_setting_prefixes[2]
		and provider_setting_prefixes[1] != provider_setting_prefixes[2]
		and not str(provider_setting_prefixes[0]).contains(dock.DEFAULT_PROVIDER)
		and not str(provider_setting_prefixes[1]).contains("deepseek")
		and not str(provider_setting_prefixes[2]).contains("opencode-zen")
	)
	dock._on_settings_provider_selected(local_provider_index)
	dock._apply_settings()
	var runtime_config := dock._build_runtime_config()
	var provider_protocol_is_neutral: bool = (
		dynamic_providers
		and dock._provider_id == "local-test"
		and runtime_config.get("provider_id") == "local-test"
		and runtime_config.get("provider_config") is Dictionary
		and runtime_config.get("approval_mode") == "ask"
		and not runtime_config.has("base_url")
		and dock._stable_config_value({"b": "2", "a": "1"}) == dock._stable_config_value({"a": "1", "b": "2"})
	)
	dock._approval_request_id = "current"
	dock._clear_approval("other")
	var ignores_stale_resolution := dock._approval_request_id == "current"
	dock._clear_approval("current")
	var approved_operations := [{"action": "remove_node", "node_path": "OldLabel"}]
	dock._register_editor_scene_write_grant("editor_operation_test", {
		"scene_id": "scene_42",
		"scene_revision": "history_1_v3",
		"changes": approved_operations,
	})
	var approved_write := dock._consume_editor_scene_write_grant({
		"operation_id": "editor_operation_test",
		"scene_id": "scene_42",
		"scene_revision": "history_1_v3",
		"operations": approved_operations.duplicate(true),
	})
	var write_grant_is_one_time := (
		bool(approved_write.get("ok", false))
		and not bool(dock._consume_editor_scene_write_grant({
			"operation_id": "editor_operation_test",
			"scene_id": "scene_42",
			"scene_revision": "history_1_v3",
			"operations": approved_operations,
		}).get("ok", true))
	)
	dock._register_editor_scene_write_grant("editor_operation_mismatch", {
		"scene_id": "scene_42",
		"scene_revision": "history_1_v3",
		"changes": approved_operations,
	})
	var mismatched_write := dock._consume_editor_scene_write_grant({
		"operation_id": "editor_operation_mismatch",
		"scene_id": "scene_other",
		"scene_revision": "history_1_v3",
		"operations": approved_operations,
	})
	var write_grant_binds_preview := not bool(mismatched_write.get("ok", true))
	dock._register_editor_scene_write_grant("editor_operation_wrong_turn", {
		"scene_id": "scene_42",
		"scene_revision": "history_1_v3",
		"changes": approved_operations,
	}, "turn_a")
	var wrong_turn_write := dock._consume_editor_scene_write_grant({
		"operation_id": "editor_operation_wrong_turn",
		"scene_id": "scene_42",
		"scene_revision": "history_1_v3",
		"operations": approved_operations,
	}, "turn_b")
	write_grant_binds_preview = write_grant_binds_preview and not bool(wrong_turn_write.get("ok", true))
	var live_scene_log := dock._format_tool_arguments("scene_apply_operations", {
		"scene_id": "scene_42",
		"scene_revision": "history_1_v3",
		"operations": [
			{"action": "rename_node", "node_path": "Title", "new_name": "Heading"},
			{"action": "remove_node", "node_path": "OldLabel"},
			{"action": "duplicate_node", "node_path": "Icon", "parent_path": "HUD"},
			{
				"action": "reparent_node",
				"node_path": "Icon",
				"new_parent_path": "HUD",
				"keep_global_transform": false,
			},
			{
				"action": "set_property",
				"node_path": "Icon",
				"property": "texture",
				"value": {
					"godot_type": "Resource",
					"uid": "uid://abc123",
					"expected_type": "Texture2D",
				},
			},
		],
	})
	var live_scene_changes := dock._format_editor_changes([
		{"action": "add_node", "parent_path": ".", "name": "Caption", "node_type": "Label"},
		{"action": "set_property", "node_path": "Caption", "property": "text"},
	])
	var live_scene_output := dock._format_tool_output("scene_apply_operations", {
		"ok": true,
		"operation_count": 2,
		"undo_action": "GodotX: Edit current scene",
	})
	var compact_scene_result := dock._compact_scene_mutation_result({
		"ok": true,
		"operation_id": "editor_operation_large_result",
		"scene_id": "scene_42",
		"scene_path": "res://demo/main.tscn",
		"previous_scene_revision": "history_1_v3",
		"scene_revision": "history_1_v4",
		"undo_action": "GodotX: Apply large result",
		"operation_count": 1,
		"change_count": 1,
		"changes": [{"after": "x".repeat(1024)}],
	})
	var committed_result_never_becomes_failure := (
		bool(compact_scene_result.get("ok", false))
		and bool(compact_scene_result.get("result_truncated", false))
		and str(compact_scene_result.get("previous_scene_revision", "")) == "history_1_v3"
		and str(compact_scene_result.get("scene_revision", "")) == "history_1_v4"
		and (compact_scene_result.get("changes", []) as Array).is_empty()
		and dock._format_tool_output("scene_apply_operations", compact_scene_result).contains("detailed change output")
		and JSON.stringify(compact_scene_result).to_utf8_buffer().size() < 2_000_000
	)
	var live_scene_ui: bool = (
		live_scene_log.contains("Rename Title -> Heading")
		and live_scene_log.contains("Revision: history_1_v3")
		and live_scene_log.contains("Remove OldLabel")
		and live_scene_log.contains("Duplicate Icon under HUD (auto name)")
		and live_scene_log.contains("Preserve global transform: false")
		and live_scene_log.contains("uid://abc123 (Texture2D)")
		and live_scene_changes.contains("Created  Caption (Label)")
		and live_scene_changes.contains("Modified  Caption.text")
		and live_scene_output.contains("Applied 2 live scene operations")
		and live_scene_output.contains("Undo action")
		and committed_result_never_becomes_failure
	)
	var dock_source := FileAccess.get_file_as_string("res://addons/godetx/godetx_dock.gd")
	var open_settings_source := dock_source.get_slice("func _open_settings() -> void:", 1).get_slice(
		"func _apply_settings() -> void:", 0
	)
	var load_settings_source := dock_source.get_slice(
		"func _load_persisted_connection_settings(settings_prefix: String = \"\") -> void:", 1
	).get_slice("func _persist_connection_settings(settings_prefix: String = \"\") -> void:", 0)
	var persist_settings_source := dock_source.get_slice(
		"func _persist_connection_settings(settings_prefix: String = \"\") -> void:", 1
	).get_slice("func _persist_auto_approve_setting(settings_prefix: String = \"\") -> void:", 0)
	var submit_source := dock_source.get_slice("func _submit() -> void:", 1).get_slice(
		"func _start_queued_turn() -> void:", 0
	)
	var start_turn_source := dock_source.get_slice("func _start_queued_turn() -> void:", 1).get_slice(
		"func _build_turn_prompt(user_prompt: String, context: Dictionary = {}) -> String:", 0
	)
	var runtime_setting_contract: bool = (
		dock.SETTINGS_SCHEMA_VERSION >= 3
		and dock_source.contains("SETTING_RUNTIME_AUTOMATION_ENABLED := \"runtime_automation_enabled\"")
		and open_settings_source.contains("_runtime_automation.button_pressed = _runtime_automation_enabled")
		and load_settings_source.contains("settings.has_setting(runtime_automation_setting)")
		and load_settings_source.contains("settings.get_setting(runtime_automation_setting)")
		and persist_settings_source.contains(
			"[prefix, SETTING_RUNTIME_AUTOMATION_ENABLED], _runtime_automation_enabled"
		)
	)
	var turn_snapshot_contract: bool = (
		submit_source.contains("_queued_runtime_automation_enabled = _runtime_automation_enabled")
		and start_turn_source.contains("\"runtime_automation_enabled\": _queued_runtime_automation_enabled")
		and start_turn_source.contains("_queued_runtime_automation_enabled = false")
	)
	var valid_policy: bool = (
		defaults_to_ask
		and adaptive_loop_config
		and settings_are_separate
		and uses_dropdowns
		and draft_does_not_apply
		and settings_applied
		and unconfirmed_draft_is_ignored
		and composer_can_request_approval
		and composer_can_approve_for_user
		and auto_approval_copy_is_clear
		and running_mode_is_frozen
		and default_model_selected
		and expected_default_model
		and default_reasoning_uses_capabilities
		and sol_offers_max
		and unchanged_connection_does_not_sync
		and remember_opt_out_keeps_session_key
		and long_model_is_clipped
		and provider_specific_reasoning
		and settings_lock_during_sync
		and runtime_toggle_unlocks
		and secure_url_policy
		and platform_path_scoping
		and stream_state_resets
		and reasoning_uses_capabilities
		and deepseek_settings_are_isolated
		and zen_settings_are_isolated
		and zen_runtime_config_is_exact
		and provider_setting_prefixes_are_isolated
		and provider_protocol_is_neutral
		and ignores_stale_resolution
		and write_grant_is_one_time
		and write_grant_binds_preview
		and live_scene_ui
		and runtime_setting_contract
		and turn_snapshot_contract
		and dock._approval_request_id.is_empty()
		and dock._should_auto_approve("file_change")
		and dock._should_auto_approve("godot_scene")
		and dock._should_auto_approve("editor_scene")
		and dock._should_auto_approve("command")
		and dock._should_auto_approve("editor_game")
		and not dock._should_auto_approve("future_high_risk_tool")
	)
	dock.free()
	Localization.uninstall()
	if not valid_policy:
		printerr("GodotX dock settings or approval policy is invalid")
		quit(1)
		return
	print("GODETX_DOCK_UI_OK")
	print("GODETX_AUTO_APPROVAL_OK")
	quit(0)
