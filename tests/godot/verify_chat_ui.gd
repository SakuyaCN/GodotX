extends SceneTree

const DockContent := preload("res://addons/godetx/godetx_dock.gd")
const AttachmentStore := preload("res://addons/godetx/attachment_store.gd")
const Localization := preload("res://addons/godetx/localization.gd")
const MarkdownRenderer := preload("res://addons/godetx/markdown_renderer.gd")
const ResourceDropTarget := preload("res://addons/godetx/resource_drop_target.gd")

var _failures := PackedStringArray()
var _captured_image_completion: Dictionary = {}


func _init() -> void:
	Localization.install_for_locale("en_US")
	var dock := DockContent.new()
	dock._build_ui()
	dock.image_generation_completed.connect(_capture_image_completion)
	dock._pending["image-edit-completion"] = "image.edit"
	dock._image_generation_requests["image-edit-completion"] = "authoritative_generation_id"
	dock._handle_response({
		"id": "image-edit-completion",
		"result": {
			"generation_id": "untrusted_runtime_id",
			"resource_path": "res://assets/generated/result.png",
		},
	})
	_assert(
		str(_captured_image_completion.get("generation_id", "")) == "authoritative_generation_id"
		and str(_captured_image_completion.get("resource_path", ""))
			== "res://assets/generated/result.png"
		and not dock._image_generation_requests.has("image-edit-completion"),
		"Image edit completion should use the generation ID bound to its request"
	)
	dock.image_generation_completed.disconnect(_capture_image_completion)
	var configured_socket := WebSocketPeer.new()
	dock._configure_socket(configured_socket)
	_assert(
		configured_socket.inbound_buffer_size == dock.SOCKET_BUFFER_SIZE
		and configured_socket.outbound_buffer_size == dock.SOCKET_BUFFER_SIZE,
		"Runtime WebSocket buffers should accept bounded editor tool results in both directions"
	)
	dock._session_id = "session_editor_tools"
	dock._turn_in_progress = true
	dock._active_turn_id = "turn_editor_tools"
	_assert(
		dock._editor_tool_request_context_error(
			"session_editor_tools",
			"turn_editor_tools"
		).is_empty()
		and not dock._editor_tool_request_context_error(
			"session_other",
			"turn_editor_tools"
		).is_empty()
		and not dock._editor_tool_request_context_error(
			"session_editor_tools",
			"turn_other"
		).is_empty(),
		"Editor tool requests should validate both conversation and task identity"
	)
	dock._turn_in_progress = false
	dock._active_turn_id = ""
	dock._session_id = ""
	_assert(
		dock._register_editor_tool_response("editor_sync_test", "game_debug_status")
		and not dock._register_editor_tool_response("editor_sync_test", "game_debug_status")
		and bool((dock._pending_editor_tool_responses["editor_sync_test"] as Dictionary).get(
			"synchronous",
			false
		)),
		"Synchronous editor requests should be registered exactly once"
	)
	dock._pending_editor_tool_responses.erase("editor_sync_test")
	_assert(
		dock._register_editor_tool_response("editor_capture_test", "game_capture_screenshot")
		and not bool((dock._pending_editor_tool_responses["editor_capture_test"] as Dictionary).get(
			"synchronous",
			true
		)),
		"Deferred screenshots should not use the short synchronous watchdog"
	)
	dock._pending_editor_tool_responses.erase("editor_capture_test")

	var enter := _key_event(KEY_ENTER)
	var keypad_enter := _key_event(KEY_KP_ENTER)
	var shifted_enter := _key_event(KEY_ENTER, true, true)
	var repeated_enter := _key_event(KEY_ENTER, true, false, true)
	var released_enter := _key_event(KEY_ENTER, false)
	var letter := _key_event(KEY_A)
	var image_paste := _key_event(KEY_V)
	image_paste.ctrl_pressed = true
	_assert(
		dock._prompt_key_action(enter) == dock.PROMPT_KEY_SUBMIT,
		"Enter should submit"
	)
	_assert(
		dock._prompt_key_action(keypad_enter) == dock.PROMPT_KEY_SUBMIT,
		"Keypad Enter should submit"
	)
	_assert(
		dock._prompt_key_action(shifted_enter) == dock.PROMPT_KEY_PASS,
		"Shift+Enter should remain a newline"
	)
	_assert(
		dock._prompt_key_action(repeated_enter) == dock.PROMPT_KEY_CONSUME,
		"Repeated Enter should be consumed without another submit"
	)
	_assert(
		dock._prompt_key_action(released_enter) == dock.PROMPT_KEY_PASS,
		"Key release should not submit"
	)
	_assert(dock._prompt_key_action(letter) == dock.PROMPT_KEY_PASS, "Other keys should pass through")
	_assert(
		dock._prompt_key_action(enter, true) == dock.PROMPT_KEY_PASS,
		"IME confirmation should not submit"
	)
	_assert(
		dock._is_image_paste_shortcut(image_paste)
		and not dock._is_image_paste_shortcut(image_paste, true),
		"Ctrl/Cmd+V image paste should preserve IME composition"
	)

	_assert(dock._composer.is_ancestor_of(dock._prompt), "Prompt should live inside the composer")
	_assert(
		dock._composer_drop_target != null
		and dock._composer_drop_target.get_script() == ResourceDropTarget
		and dock._composer == dock._composer_drop_target
		and dock._composer_drop_target.accepted_extensions.has("png")
		and dock._composer_drop_target.accepted_extensions.has("tscn"),
		"The composer should accept the same project resources as its attachment picker"
	)
	var composer_drop := {
		"type": "files",
		"files": PackedStringArray(["res://demo/Demon_A_Attack01.png"]),
	}
	dock._server_ready = true
	dock._models_ready = true
	_assert(
		dock._composer_drop_target._can_drop_data(Vector2.ZERO, composer_drop),
		"The ready composer should accept a FileSystem image drag"
	)
	dock._turn_in_progress = true
	_assert(
		not dock._composer_drop_target._can_drop_data(Vector2.ZERO, composer_drop),
		"The composer should reject resource drops while a task is running"
	)
	dock._turn_in_progress = false
	dock._pending_visual_imports = AttachmentStore.MAX_ATTACHMENTS_PER_TURN
	_assert(
		not dock._can_add_visual_attachment(false),
		"In-flight resource previews should count toward the attachment limit"
	)
	dock._pending_visual_imports = 0
	_assert(
		DockContent._runtime_connection_warning_due(false, false, 1000, 9000)
		and not DockContent._runtime_connection_warning_due(false, true, 1000, 9000)
		and not DockContent._runtime_connection_warning_due(true, false, 1000, 9000),
		"Runtime startup failures should become visible once without mislabeling a connected runtime"
	)
	dock._provider_configs[dock.DEFAULT_PROVIDER] = {
		"base_url": "https://example.invalid/v1",
		"api_key": "invalid-test-key",
	}
	dock._configure_purpose = "models"
	dock._configure_fingerprint_pending = dock._connection_fingerprint()
	dock._pending["configure-before-auth"] = "configure"
	dock._handle_response({
		"id": "configure-before-auth",
		"result": {"configured": true},
	})
	_assert(
		not dock._session_sync_in_flight,
		"Conversation restore should wait until provider model authentication succeeds"
	)
	dock._model_sync_in_flight = true
	dock._pending["auth-models-1"] = "models.list"
	dock._handle_response({
		"id": "auth-models-1",
		"error": {
			"code": "PROVIDER_AUTH_FAILED",
			"message": "HTTP 401: invalid-test-key",
			"data": {"status": 401},
		},
	})
	var auth_message_count := dock._conversation.get_child_count()
	_assert(
		auth_message_count == 1
		and dock._status.text == "Authentication failed"
		and dock._status.tooltip_text.contains("HTTP 401")
		and not dock._status.tooltip_text.contains("invalid-test-key")
		and _has_label_text(
			dock._conversation,
			"Provider authentication failed (HTTP 401). Open Connection settings and check the API key or account permissions."
		),
		"Invalid API keys should produce one safe actionable conversation message"
	)
	dock._model_sync_in_flight = true
	dock._pending["auth-models-2"] = "models.list"
	dock._handle_response({
		"id": "auth-models-2",
		"error": {
			"code": "PROVIDER_AUTH_FAILED",
			"message": "HTTP 401: repeated invalid-test-key",
			"data": {"status": 401},
		},
	})
	_assert(
		dock._conversation.get_child_count() == auth_message_count,
		"Repeated authentication failures for one connection should not spam the conversation"
	)
	const BILLING_MESSAGE := (
		"Provider balance is insufficient. Add credits in the provider billing settings, then retry."
	)
	const RAW_BILLING_URL := "https://opencode.ai/workspace/wrk_TEST_SECRET/billing"
	const RAW_BILLING_ERROR := (
		"HTTP 401: {\"type\":\"error\",\"error\":{\"type\":\"CreditsError\","
		+ "\"message\":\"Insufficient balance. Manage your billing here: %s\"}}"
	) % RAW_BILLING_URL
	_assert(
		Localization.translate_for_locale(BILLING_MESSAGE, "zh_CN") != BILLING_MESSAGE,
		"The safe provider billing notice should have a Chinese translation"
	)
	dock._clear_conversation()
	dock._model_sync_in_flight = true
	dock._pending["billing-models-1"] = "models.list"
	dock._handle_response({
		"id": "billing-models-1",
		"error": {
			"code": "PROVIDER_BILLING_FAILED",
			"message": RAW_BILLING_ERROR,
			"data": {"status": 401},
		},
	})
	var billing_message_count := dock._conversation.get_child_count()
	_assert(
		billing_message_count == 1
		and dock._status.text == "Insufficient balance"
		and dock._status.text != "Authentication failed"
		and dock._status.tooltip_text == BILLING_MESSAGE
		and _count_label_text(dock._conversation, BILLING_MESSAGE) == 1
		and _find_label_containing(dock._conversation, RAW_BILLING_URL) == null
		and _find_label_containing(dock._conversation, "wrk_TEST_SECRET") == null
		and not dock._status.tooltip_text.contains(RAW_BILLING_URL)
		and not dock._status.tooltip_text.contains("wrk_TEST_SECRET"),
		"Provider billing responses should show one safe notice without exposing billing identifiers"
	)
	dock._model_sync_in_flight = true
	dock._pending["billing-models-2"] = "models.list"
	dock._handle_response({
		"id": "billing-models-2",
		"error": {
			"code": "PROVIDER_BILLING_FAILED",
			"message": RAW_BILLING_ERROR,
			"data": {"status": 401},
		},
	})
	_assert(
		dock._conversation.get_child_count() == billing_message_count
		and _count_label_text(dock._conversation, BILLING_MESSAGE) == 1,
		"Repeated billing failures for one connection should not spam the conversation"
	)

	# Exercise the streamed failure path independently from the request-response path.
	dock._clear_conversation()
	dock._reported_connection_notice_key = ""
	dock._server_ready = false
	dock._session_id = "session_billing_failure"
	dock._turn_in_progress = true
	dock._active_turn_id = "turn_billing_failure_1"
	dock._handle_event(_runtime_event(
		"turn.failed",
		"",
		{
			"status": "failed",
			"error": RAW_BILLING_ERROR,
			"code": "PROVIDER_BILLING_FAILED",
			"data": {"status": 401},
		},
		"turn_billing_failure_1"
	))
	var streamed_billing_message_count := dock._conversation.get_child_count()
	_assert(
		streamed_billing_message_count == 1
		and dock._status.text == "Insufficient balance"
		and dock._status.text != "Authentication failed"
		and dock._status.tooltip_text == BILLING_MESSAGE
		and _count_label_text(dock._conversation, BILLING_MESSAGE) == 1
		and _find_label_containing(dock._conversation, RAW_BILLING_URL) == null
		and _find_label_containing(dock._conversation, "wrk_TEST_SECRET") == null,
		"Billing turn failures should render one safe notice instead of the provider payload"
	)
	dock._turn_in_progress = true
	dock._active_turn_id = "turn_billing_failure_2"
	dock._handle_event(_runtime_event(
		"turn.failed",
		"",
		{
			"status": "failed",
			"error": RAW_BILLING_ERROR,
			"code": "PROVIDER_BILLING_FAILED",
			"data": {"status": 401},
		},
		"turn_billing_failure_2"
	))
	_assert(
		dock._conversation.get_child_count() == streamed_billing_message_count
		and _count_label_text(dock._conversation, BILLING_MESSAGE) == 1,
		"Repeated billing turn failures for one connection should reuse the existing notice"
	)
	dock._render_session_snapshot({
		"session_id": "session_billing_history",
		"turns": [{
			"turn_id": "turn_billing_history",
			"prompt": "HI",
			"status": "failed",
			"error": RAW_BILLING_ERROR,
			"error_code": "PROVIDER_BILLING_FAILED",
			"error_status": 401,
			"duration_ms": 2000,
			"usage": {},
			"entries": [],
		}],
	})
	_assert(
		_count_label_text(dock._conversation, BILLING_MESSAGE) == 1
		and _find_label_containing(dock._conversation, RAW_BILLING_URL) == null
		and _find_label_containing(dock._conversation, "wrk_TEST_SECRET") == null,
		"Restored billing failures should use the safe structured notice"
	)
	dock._clear_conversation()
	dock._server_ready = false
	dock._models_ready = false
	dock._session_id = ""
	dock._active_turn_id = ""
	dock._turn_in_progress = false
	_assert(dock._composer.is_ancestor_of(dock._model_select), "Model should live in the composer toolbar")
	_assert(dock._composer.is_ancestor_of(dock._reasoning_select), "Reasoning should live in the composer toolbar")
	_assert(dock._composer.is_ancestor_of(dock._approval_mode_select), "Approval mode should live in the composer toolbar")
	_assert(dock._composer.is_ancestor_of(dock._attachment_menu), "Visual attachments should live in the composer")
	_assert(dock._attachment_menu is MenuButton, "Visual attachment sources should use a menu")
	_assert(
		dock._attachment_menu.get_popup().item_count >= 5,
		"Attachment menu should expose files, project resources, and editor viewports"
	)
	_assert(dock._attachment_file_dialog.file_mode == FileDialog.FILE_MODE_OPEN_FILES, "Image picker should support multiple files")
	_assert(dock._attachment_project_dialog.access == FileDialog.ACCESS_RESOURCES, "Project previews should stay inside res://")
	_assert(
		dock._annotation_dialog is Window
		and dock._annotation_editor is Control
		and dock._annotation_tool_buttons.size() == 3
		and not dock._annotation_dialog.visible,
		"Visual attachments should expose one reusable annotation editor"
	)
	_assert(
		dock._image_input_capability({"image_input": {"status": "supported"}})
		== dock.IMAGE_CAPABILITY_SUPPORTED
		and dock._image_input_capability({"image_input": {"status": "unsupported"}})
		== dock.IMAGE_CAPABILITY_UNSUPPORTED
		and dock._image_input_capability({"image_input": {"status": "unknown"}})
		== dock.IMAGE_CAPABILITY_UNKNOWN,
		"Image capability status should preserve supported, unsupported, and unknown"
	)
	_assert(
		dock._tool_icon_name("game_capture_screenshot") == "SceneTask"
		and dock._tool_title("game_capture_screenshot", {}) == "Capture running game frame"
		and dock._format_tool_arguments("game_capture_screenshot", {
			"run_id": "0123456789abcdef0123456789abcdef",
			"max_dimension": 1280,
			"detail": "low",
		}).contains("1280"),
		"Running game screenshots should use the scene tool presentation"
	)
	_assert(
		dock._tool_title("run_command", {"command": ["cat", "demo/main.gd"]})
		== "Read demo/main.gd"
		and dock._format_tool_arguments("run_command", {"command": ["cat", "demo/main.gd"]})
		== "Path: demo/main.gd"
		and dock._format_tool_output("run_command", {
			"ok": true,
			"path": "demo/main.gd",
			"content": "extends Node",
			"handled_by": "read_file",
		}) == "extends Node"
		and dock._tool_title("run_command", {"command": ["cat", "-n", "demo/main.gd"]})
		== "Run cat -n demo/main.gd",
		"Portable file-read compatibility should be presented as read_file, not a command"
	)
	_assert(dock._approval_mode_select is OptionButton, "Approval mode should use a dropdown")
	_assert(dock._approval_mode_select.item_count == 2, "Approval mode should expose exactly two policies")
	_assert(
		str(dock._approval_mode_select.get_item_metadata(0)) == dock.APPROVAL_MODE_ASK
		and dock._approval_mode_select.get_item_text(0) == dock.APPROVAL_LABEL_ASK
		and str(dock._approval_mode_select.get_item_metadata(1)) == dock.APPROVAL_MODE_AUTO_EDITS
		and dock._approval_mode_select.get_item_text(1) == dock.APPROVAL_LABEL_AUTO_EDITS
		and dock._selected_approval_mode() == dock.APPROVAL_MODE_ASK,
		"Composer approval policies should default to asking"
	)
	_assert(dock._conversation_scroll.is_ancestor_of(dock._conversation), "Message list should be scrollable")
	_assert(dock.custom_minimum_size.y == 0.0, "The Dock should be allowed to shrink vertically")
	_assert(
		dock._conversation_scroll.custom_minimum_size.y == 0.0
		and dock._conversation_scroll.size_flags_vertical == Control.SIZE_EXPAND_FILL,
		"The message list should absorb small-height layout pressure"
	)
	_assert(
		dock._composer.size_flags_vertical == Control.SIZE_SHRINK_END,
		"The composer should keep its intrinsic height at the bottom of the Dock"
	)
	_assert(dock._prompt.custom_minimum_size.y == 76.0, "Composer input height should be stable")
	_assert(
		dock._send_button.custom_minimum_size == dock._stop_button.custom_minimum_size,
		"Send and stop controls should not shift the layout"
	)
	_assert(
		dock._model_select.custom_minimum_size.x
		+ dock._reasoning_select.custom_minimum_size.x
		+ dock._approval_mode_select.custom_minimum_size.x
		+ dock._send_button.custom_minimum_size.x
		+ 18.0 <= 340.0,
		"Composer controls should fit the minimum dock width"
	)
	_assert(not dock._send_button.tooltip_text.is_empty(), "Send button needs a tooltip")
	_assert(not dock._stop_button.tooltip_text.is_empty(), "Stop button needs a tooltip")
	_assert(
		dock._prompt.gui_input.is_connected(dock._on_prompt_gui_input),
		"Prompt should handle keyboard submission"
	)
	var markdown_body := dock._message_label()
	dock._render_markdown_subset(markdown_body, """### Online players

| Rank | Game | Players | Trend |
| ---: | :--- | ---: | :---: |
| 1 | **Counter-Strike 2** | 693k | +8% |
| 2 | A \\| B | `x|y` | [Source](https://example.com) |
| 3 | C:\\temp | value | ok |

- First item
1. Second item
> Quoted result
runtime_automation_enabled stays literal

```gdscript
var value := 1
```
""")
	var markdown_text := markdown_body.get_parsed_text()
	_assert(markdown_text.contains("Online players"), "Markdown headings should retain their text")
	_assert(not markdown_text.contains("### Online players"), "Markdown heading markers should be hidden")
	_assert(markdown_text.contains("Counter-Strike 2"), "Markdown tables should render inline emphasis")
	_assert(markdown_text.contains("A | B"), "Escaped table pipes should remain inside their cell")
	_assert(markdown_text.contains("x|y"), "Inline code pipes should not split table cells")
	_assert(markdown_text.contains("C:\\temp"), "Ordinary table backslashes should remain literal")
	_assert(not markdown_text.contains("| ---:"), "Markdown table delimiters should not be visible")
	_assert(markdown_text.contains("First item"), "Markdown unordered lists should render")
	_assert(markdown_text.contains("Second item"), "Markdown ordered lists should render")
	_assert(markdown_text.contains("Quoted result"), "Markdown quotes should render")
	_assert(
		markdown_text.contains("runtime_automation_enabled"),
		"Intraword underscores should not be treated as italic markers"
	)
	_assert(markdown_text.contains("var value := 1"), "Markdown fenced code should render")
	_assert(not markdown_text.contains("```"), "Markdown code fences should not be visible")
	_assert(not markdown_body.bbcode_enabled, "Markdown rendering must not enable model-controlled BBCode")
	_assert(
		markdown_body.meta_clicked.is_connected(dock._on_message_meta_clicked),
		"Markdown links should use the guarded message link handler"
	)
	_assert(MarkdownRenderer.is_safe_link("https://example.com/docs"), "HTTPS links should be accepted")
	_assert(not MarkdownRenderer.is_safe_link("javascript:alert(1)"), "Unsafe link schemes should be rejected")
	dock._render_markdown_subset(markdown_body, "[color=red]literal[/color]")
	_assert(
		markdown_body.get_parsed_text() == "[color=red]literal[/color]",
		"Model-provided BBCode must remain literal text"
	)
	var contextual_prompt := dock._format_turn_prompt("Edit the current Title", {
		"current_scene": "demo/main.tscn",
		"current_scene_root": "Main (Node2D)",
		"current_script": "demo/main.gd",
		"open_scenes": PackedStringArray(["demo/main.tscn"]),
		"scene_context": {
			"primary_scene_id": "scene_a",
			"leases": {
				"scene_a": {
					"has_scene": true,
					"available": true,
					"scene_id": "scene_a",
					"scene_path": "res://demo/main.tscn",
					"scene_revision": "history_1_v4",
					"scene_root_name": "Main",
					"scene_root_type": "Node2D",
				},
			},
		},
	})
	_assert(contextual_prompt.contains("current_scene: demo/main.tscn"), "Turn prompt should include current scene")
	_assert(contextual_prompt.contains("primary_scene_id: scene_a"), "Turn prompt should identify its frozen primary scene")
	_assert(contextual_prompt.contains("scene_id: scene_a; path: demo/main.tscn"), "Turn prompt should expose safe open-scene targets")
	_assert(contextual_prompt.contains("current_script: demo/main.gd"), "Turn prompt should include current script")
	_assert(contextual_prompt.ends_with("User request:\nEdit the current Title"), "Context must preserve the user request")
	_assert(dock._format_turn_prompt("Plain request", {}) == "Plain request", "Empty editor context should not wrap prompts")
	_assert(
		dock._workspace_relative_resource_path("res://demo/main.tscn") == "demo/main.tscn",
		"Editor resource paths should become workspace-relative"
	)
	var lease_a := {
		"has_scene": true,
		"available": true,
		"scene_id": "scene_a",
		"scene_path": "res://demo/main.tscn",
		"scene_revision": "history_1_v4",
	}
	var lease_b := {
		"has_scene": true,
		"available": true,
		"scene_id": "scene_b",
		"scene_path": "res://demo/other.tscn",
		"scene_revision": "history_2_v1",
	}
	var multi_scene_context := {
		"primary_scene_id": "scene_a",
		"leases": {"scene_a": lease_a, "scene_b": lease_b},
	}
	_assert(
		dock._scene_context_protocol_leases(multi_scene_context).size() == 2,
		"A turn should preserve a distinct lease for every scene open at submission"
	)
	dock._pending_turn_scene_context = multi_scene_context.duplicate(true)
	dock._bind_pending_turn_scene_lease("turn_scene_guard")
	_assert(
		dock._turn_scene_contexts.has("turn_scene_guard")
		and dock._pending_turn_scene_context.is_empty(),
		"Pending scene leases should bind exactly once to the Runtime turn id"
	)
	dock._clear_turn_scene_lease("turn_scene_guard")
	_assert(dock._turn_scene_contexts.is_empty(), "Completed turns should release their scene leases")

	dock._add_user_message("Inspect the player scene")
	dock._begin_activity_indicator()
	dock._turn_in_progress = true
	dock._handle_event(_runtime_event("turn.started", "", {}))
	var initial_children := dock._conversation.get_children()
	var user_root := initial_children[0]
	var activity_root := initial_children[1]
	var activity_timeline := dock._activity_timeline
	var activity_label := dock._activity_label
	_assert(str(user_root.get_meta("message_kind")) == "user", "First item should be the user message")
	_assert(_has_label_text(user_root, "You"), "User message should have a visible You label")
	var user_margin := user_root.get_child(1) as MarginContainer
	_assert(user_margin != null, "User bubble should have a responsive left margin")
	if user_margin != null:
		_assert(user_margin.get_theme_constant("margin_left") >= 24, "User bubble should be visually right aligned")
	_assert(
		str(activity_root.get_meta("message_kind")) == "assistant_turn",
		"One assistant turn should own the activity header and timeline"
	)
	_assert(_count_label_text(activity_root, "GodotX") == 1, "A turn should show exactly one GodotX label")
	_assert(activity_label.text.begins_with("Thinking"), "Thinking indicator should be visible before output")
	dock._set_activity_phase("Working")
	dock._update_activity_indicator(true)
	_assert(activity_label.text.begins_with("Working"), "Tool phase should update the activity indicator")
	dock._set_activity_phase("Thinking")

	dock._handle_event(_runtime_event("message.delta", "m1", {"delta": "First [literal]"}))
	dock._handle_event(_runtime_event("message.completed", "m1", {"text": "First [literal]"}))
	dock._handle_event(_runtime_event(
		"tool.started",
		"t1",
		{"name": "read_file", "arguments": {"path": "demo/main.gd"}}
	))
	dock._handle_event(_runtime_event(
		"tool.completed",
		"t1",
		{"name": "read_file", "output": {"path": "demo/main.gd", "content": "extends Node"}}
	))
	dock._handle_event(_runtime_event("message.delta", "m2", {"delta": "Second"}))
	dock._flush_deltas()

	var children := dock._conversation.get_children()
	var timeline_children := activity_timeline.get_children()
	_assert(children.size() == 2, "A user message and one assistant turn should be the only top-level items")
	_assert(timeline_children.size() == 3, "Expected assistant, tool, assistant order inside one turn timeline")
	_assert(
		str(timeline_children[0].get_meta("message_kind")) == "assistant_segment",
		"First timeline item should be an assistant segment"
	)
	_assert(str(timeline_children[0].get_meta("item_id")) == "m1", "First assistant item id is wrong")
	_assert(not _has_label_text(timeline_children[0], "GodotX"), "A step must not repeat the GodotX label")
	_assert(str(timeline_children[1].get_meta("message_kind")) == "tool", "Second timeline item should be a tool")
	_assert(str(timeline_children[1].get_meta("item_id")) == "t1", "Tool item id is wrong")
	_assert(
		str(timeline_children[2].get_meta("message_kind")) == "assistant_segment",
		"Third timeline item should be an assistant segment"
	)
	_assert(str(timeline_children[2].get_meta("item_id")) == "m2", "Second assistant item id is wrong")

	var first_view: Dictionary = dock._message_views_by_item_id["m1"]
	var second_view: Dictionary = dock._message_views_by_item_id["m2"]
	var tool_view: Dictionary = dock._tool_views_by_item_id["t1"]
	var first_body := first_view.body as RichTextLabel
	var second_body := second_view.body as RichTextLabel
	_assert(first_body.get_parsed_text() == "First [literal]", "Completed stream should not duplicate assistant text")
	_assert(not first_body.bbcode_enabled, "Message text should not interpret model BBCode")
	_assert(first_body.has_theme_stylebox_override("normal"), "Assistant text should override the inherited background")
	_assert(second_body.get_parsed_text() == "Second", "Second assistant delta was routed to the wrong message")
	_assert((tool_view.status as Label).text == "Done", "Completed tool should show Done")
	var read_details := tool_view.get("details") as Control
	var read_arguments := tool_view.get("arguments_body") as RichTextLabel
	var read_output := tool_view.get("body") as RichTextLabel
	_assert(read_details != null and not read_details.visible, "Tool details should default to collapsed")
	_assert(
		read_arguments != null and read_arguments.get_parsed_text().contains("demo/main.gd"),
		"Read tool details should include the requested path"
	)
	_assert(
		read_output != null and read_output.get_parsed_text().contains("extends Node"),
		"Read tool completion should retain file content in its detail output"
	)
	_assert(read_output != null and not read_output.fit_content, "Tool detail output should not grow without a cap")
	_assert(read_output != null and read_output.scroll_active, "Tool detail output should scroll internally")
	_assert(
		read_output != null and float(read_output.get_meta("detail_max_height", -1.0)) == dock.TOOL_DETAIL_MAX_HEIGHT,
		"Output detail should use the configured maximum height"
	)
	_assert(
		read_output != null and read_output.custom_minimum_size.y <= dock.TOOL_DETAIL_MAX_HEIGHT,
		"Output detail minimum height should stay within its cap"
	)
	var detail_style := read_output.get_theme_stylebox("normal") as StyleBoxFlat
	_assert(
		read_output.has_theme_stylebox_override("normal")
		and detail_style != null
		and detail_style.bg_color.a > 0.0
		and detail_style.content_margin_left > 0.0,
		"Tool detail output should have a padded opaque background"
	)
	_assert(
		read_output.has_theme_font_override("normal_font"),
		"Tool detail output should override the normal font"
	)
	_assert(
		not first_body.has_theme_stylebox_override("normal"),
		"Ordinary assistant messages should not use the tool detail background"
	)
	var read_toggle := tool_view.get("toggle") as Button
	read_toggle.button_pressed = true
	_assert(read_details.visible, "Clicking a tool row should expand its details")
	read_toggle.button_pressed = false
	_assert(not read_details.visible, "Clicking an expanded tool row should collapse its details")

	dock._handle_event(_runtime_event(
		"context.prepared",
		"context_live",
		{
			"source_count": 1,
			"character_count": 640,
			"index_revision": "revision-1",
			"sources": [{
				"path": "demo/main.gd",
				"line": 4,
				"reasons": ["current_script", "symbol:Title"],
				"symbols": [{"name": "Title", "kind": "variable", "line": 4}],
				"snippet": "L4: var title = \"Demo\"",
			}],
		}
	))
	var context_view: Dictionary = dock._tool_views_by_item_id.get("context_live", {})
	var context_root := context_view.get("root") as Control
	_assert(
		(context_view.get("toggle") as Button).text == "Referenced project context"
		and (context_view.get("status") as Label).text == "Done",
		"Automatic project context should use a completed dedicated card"
	)
	_assert(
		(context_view.get("arguments_body") as RichTextLabel).get_parsed_text().contains("Context sources: 1")
		and (context_view.get("body") as RichTextLabel).get_parsed_text().contains("demo/main.gd:4"),
		"Project context cards should retain bounded retrieval metadata and snippets"
	)
	_assert(
		context_root != null and _has_button_text(context_root, "demo/main.gd:4"),
		"Project context cards should expose a clickable source path"
	)

	dock._handle_event(_runtime_event(
		"tool.started",
		"t2",
		{
			"name": "apply_patch",
			"arguments": {
				"operations": [{
					"action": "replace",
					"path": "demo/main.gd",
					"old_text": "Before",
					"new_text": "After",
				}],
			},
		}
	))
	dock._handle_event(_runtime_event(
		"file_change.proposed",
		"t2",
		{
			"files": [{"path": "demo/main.gd", "kind": "update"}],
			"diff": "--- a/demo/main.gd\n+++ b/demo/main.gd\n@@\n-Before\n+After",
		}
	))
	var edit_view: Dictionary = dock._tool_views_by_item_id["t2"]
	var edit_changes := edit_view.get("changes_body") as RichTextLabel
	var edit_diff := edit_view.get("diff_body") as RichTextLabel
	_assert(
		edit_changes != null and edit_changes.get_parsed_text().contains("demo/main.gd"),
		"Proposed file changes should populate the tool change summary"
	)
	_assert(
		edit_diff != null and edit_diff.get_parsed_text().contains("+After"),
		"Proposed file changes should populate the tool diff"
	)
	var sample_diff := "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-Before\n+After\n context"
	var diff_segments: Array = dock._diff_segments(sample_diff)
	var diff_roles := PackedStringArray()
	for segment_value in diff_segments:
		var segment: Dictionary = segment_value
		diff_roles.append(str(segment.get("role", "")))
	_assert(
		diff_roles == PackedStringArray(["header", "header", "hunk", "deletion", "addition", "context"]),
		"Diff lines should be classified as header, hunk, deletion, addition, and context"
	)
	_assert(
		dock._tool_segment_color(&"addition") != dock._tool_segment_color(&"deletion"),
		"Addition and deletion lines should use different colors"
	)
	_assert(
		dock._tool_segment_background(&"addition").a > 0.0
		and dock._tool_segment_background(&"deletion").a > 0.0
		and dock._tool_segment_background(&"addition") != dock._tool_segment_background(&"deletion"),
		"Addition and deletion lines should use distinct tinted backgrounds"
	)
	var rendered_diff := dock._tool_detail_label(dock.TOOL_DETAIL_MAX_HEIGHT)
	dock._render_tool_segments(rendered_diff, diff_segments)
	_assert(rendered_diff.get_parsed_text() == sample_diff, "Colored diff rendering should preserve the original text")
	rendered_diff.free()
	_assert(dock._change_line_role("Created  res://new.gd") == &"addition", "Created files should use addition styling")
	_assert(dock._change_line_role("Deleted  res://old.gd") == &"deletion", "Deleted files should use deletion styling")
	_assert(dock._change_line_role("Modified  res://main.gd") == &"hunk", "Modified files should use modification styling")

	dock._handle_event(_runtime_event(
		"tool.started",
		"t3",
		{"name": "read_file", "arguments": {"path": "missing.gd"}}
	))
	dock._handle_event(_runtime_event(
		"tool.completed",
		"t3",
		{"name": "read_file", "output": {"ok": false, "error": "File not found"}}
	))
	var failed_view: Dictionary = dock._tool_views_by_item_id["t3"]
	var failed_details := failed_view.get("details") as Control
	_assert(failed_details != null and failed_details.visible, "Failed tools should automatically expand details")
	_assert((failed_view.status as Label).text == "Failed", "Failed tool should show Failed status")

	var automation_run_id := "0123456789abcdef0123456789abcdef"
	var automation_id := "automation_0123456789abcdef"
	dock._handle_event(_runtime_event(
		"tool.started",
		"automation_run",
		{
			"name": "game_automation_run",
			"arguments": {
				"run_id": automation_run_id,
				"steps": [
					{"type": "click_control", "node_path": "Menu/Start", "button": 1},
					{
						"type": "assert_node",
						"node_path": "Board",
						"check": "property_equals",
						"property": "visible",
						"value": true,
						"timeout_frames": 60,
					},
				],
				"stop_on_failure": true,
			},
		}
	))
	dock._handle_event(_runtime_event(
		"tool.completed",
		"automation_run",
		{
			"name": "game_automation_run",
			"output": {
				"ok": true,
				"automation_id": automation_id,
				"run_id": automation_run_id,
				"state": "failed",
				"current_step": 1,
				"step_count": 2,
				"results": [{
					"step_index": 0,
					"type": "click_control",
					"ok": true,
				}],
				"failure": "Board.visible did not equal true",
			},
		}
	))
	var automation_run_view: Dictionary = dock._tool_views_by_item_id["automation_run"]
	var automation_run_toggle := automation_run_view.get("toggle") as Button
	var automation_run_arguments := automation_run_view.get("arguments_body") as RichTextLabel
	var automation_run_output := automation_run_view.get("body") as RichTextLabel
	var automation_run_status := automation_run_view.get("status") as Label
	var automation_run_details := automation_run_view.get("details") as Control
	_assert(
		automation_run_toggle != null and automation_run_toggle.text == "Run game automation",
		"Runtime automation run cards should use a dedicated title"
	)
	_assert(
		automation_run_arguments != null
		and automation_run_arguments.get_parsed_text().contains("Run ID: %s" % automation_run_id)
		and automation_run_arguments.get_parsed_text().contains("Steps: 2")
		and automation_run_arguments.get_parsed_text().contains("Click Menu/Start")
		and automation_run_arguments.get_parsed_text().contains("Assert Board.visible property_equals true"),
		"Runtime automation run cards should expose their bounded plan"
	)
	_assert(
		dock._format_game_automation_step(
			0,
			{"type": "click_control", "node_path": "Menu/Start", "button": 1.0},
			160
		) == "1. Click Menu/Start (button 1)"
		and dock._format_game_automation_step(
			0,
			{"type": "click_control", "node_path": "Menu/Start", "button": 1.5},
			160
		) == "1. Click Menu/Start (button 1.5)",
		"Automation cards should normalize integral JSON numbers without masking fractional values"
	)
	_assert(
		automation_run_output != null
		and automation_run_output.get_parsed_text().contains("State: Failed")
		and automation_run_output.get_parsed_text().contains("Automation ID: %s" % automation_id)
		and automation_run_output.get_parsed_text().contains("Progress: 1/2")
		and automation_run_output.get_parsed_text().contains("Failure: Board.visible did not equal true"),
		"Runtime automation run cards should retain compact progress and failure output"
	)
	_assert(
		automation_run_status != null
		and automation_run_status.text == "Failed"
		and automation_run_status.get_theme_color("font_color") == Color("d87979")
		and automation_run_details != null
		and automation_run_details.visible,
		"A failed automation state should be red and automatically expanded"
	)

	dock._handle_event(_runtime_event(
		"tool.started",
		"automation_status",
		{
			"name": "game_automation_status",
			"arguments": {"run_id": automation_run_id, "automation_id": automation_id},
		}
	))
	dock._handle_event(_runtime_event(
		"tool.completed",
		"automation_status",
		{
			"name": "game_automation_status",
			"output": {
				"ok": true,
				"automation_id": automation_id,
				"run_id": automation_run_id,
				"state": "running",
				"current_step": 1,
				"step_count": 2,
			},
		}
	))
	var automation_status_view: Dictionary = dock._tool_views_by_item_id["automation_status"]
	_assert(
		(automation_status_view.toggle as Button).text == "Inspect game automation"
		and (automation_status_view.arguments_body as RichTextLabel).get_parsed_text().contains(
			"Automation ID: %s" % automation_id
		)
		and (automation_status_view.body as RichTextLabel).get_parsed_text().contains("State: Running"),
		"Runtime automation status cards should show ownership and current state"
	)

	dock._handle_event(_runtime_event(
		"tool.started",
		"automation_cancel",
		{
			"name": "game_automation_cancel",
			"arguments": {"run_id": automation_run_id, "automation_id": automation_id},
		}
	))
	dock._handle_event(_runtime_event(
		"tool.completed",
		"automation_cancel",
		{
			"name": "game_automation_cancel",
			"output": {
				"ok": true,
				"automation_id": automation_id,
				"run_id": automation_run_id,
				"state": "cancelled",
				"current_step": 1,
				"step_count": 2,
			},
		}
	))
	var automation_cancel_view: Dictionary = dock._tool_views_by_item_id["automation_cancel"]
	_assert(
		(automation_cancel_view.toggle as Button).text == "Cancel game automation"
		and (automation_cancel_view.arguments_body as RichTextLabel).get_parsed_text().contains(
			"Automation ID: %s" % automation_id
		)
		and (automation_cancel_view.body as RichTextLabel).get_parsed_text().contains("State: Cancelled"),
		"Runtime automation cancel cards should show ownership and terminal state"
	)

	dock._handle_event(_runtime_event(
		"tool.started",
		"game_test_failed",
		{
			"name": "game_test",
			"arguments": {
				"target": {"mode": "current"},
				"steps": [
					{"type": "click_control", "node_path": "Menu/Start", "button": 1},
					{
						"type": "assert_node",
						"node_path": "Board",
						"check": "property_equals",
						"property": "visible",
						"value": true,
						"timeout_frames": 60,
					},
				],
				"stop_on_failure": true,
				"cleanup": "always",
				"ready_timeout_ms": 5000,
				"automation_timeout_ms": 12000,
			},
		}
	))
	dock._handle_event(_runtime_event(
		"tool.output.delta",
		"game_test_failed",
		{"phase": "running_automation", "delta": "provider progress should be replaced\n"}
	))
	var game_test_streaming_view: Dictionary = dock._tool_views_by_item_id["game_test_failed"]
	var game_test_streaming_text := (game_test_streaming_view.body as RichTextLabel).get_parsed_text()
	_assert(
		game_test_streaming_text.contains("Running game automation")
		and not game_test_streaming_text.contains("provider progress should be replaced"),
		"Composite game-test phases should use stable localized progress labels"
	)
	dock._handle_event(_runtime_event(
		"tool.completed",
		"game_test_failed",
		{
			"name": "game_test",
			"output": {
				"ok": false,
				"state": "failed",
				"run_id": automation_run_id,
				"automation_id": automation_id,
				"launch": {
					"start": {"ok": true, "run_id": automation_run_id},
					"status": {"ok": true, "probe_active": true},
				},
				"automation": {
					"start": {"ok": true, "automation_id": automation_id},
					"status": {
						"ok": true,
						"state": "failed",
						"current_step": 1,
						"step_count": 2,
						"results": [{"step_index": 0, "type": "click_control", "ok": true},],
					},
				},
				"cleanup": {
					"policy": "always",
					"attempted": true,
					"stop_attempted": true,
					"stop_requested": true,
					"stopped": true,
					"stop": {"ok": true, "stop_requested": true},
				},
				"stopped": true,
				"failure": "Board.visible did not equal true",
				"timings_ms": {"ready": 120, "automation": 400, "cleanup": 30, "total": 550},
			},
		}
	))
	var game_test_view: Dictionary = dock._tool_views_by_item_id["game_test_failed"]
	var game_test_arguments := (game_test_view.arguments_body as RichTextLabel).get_parsed_text()
	var game_test_output := (game_test_view.body as RichTextLabel).get_parsed_text()
	_assert(
		dock._tool_icon_name("game_test") == "SceneTask"
		and (game_test_view.toggle as Button).text == "Test current scene"
		and game_test_arguments.contains("Mode: Current editor scene")
		and game_test_arguments.contains("Steps: 2")
		and game_test_arguments.contains("Cleanup policy: Always")
		and game_test_arguments.contains("Ready timeout: 5000 ms")
		and game_test_arguments.contains("Automation timeout: 12000 ms"),
		"Composite game-test cards should summarize their target, plan, cleanup, and timeouts"
	)
	_assert(
		game_test_output.contains("State: Failed")
		and game_test_output.contains("Launch: Ready")
		and game_test_output.contains("Automation: Failed")
		and game_test_output.contains("Progress: 1/2")
		and game_test_output.contains("Cleanup: Stopped")
		and game_test_output.contains("Game stopped after test.")
		and game_test_output.contains("Total duration: 550 ms")
		and game_test_output.contains("Failure: Board.visible did not equal true"),
		"Composite game-test cards should retain the complete local execution report"
	)
	_assert(
		(game_test_view.status as Label).text == "Failed"
		and (game_test_view.status as Label).get_theme_color("font_color") == Color("d87979")
		and (game_test_view.details as Control).visible,
		"Failed composite game tests should be red and automatically expanded"
	)

	dock._handle_event(_runtime_event(
		"tool.started",
		"t4",
		{"name": "read_file", "arguments": "{invalid arguments"}
	))
	var invalid_view: Dictionary = dock._tool_views_by_item_id["t4"]
	_assert(
		(invalid_view.arguments_body as RichTextLabel).get_parsed_text() == "{invalid arguments",
		"Invalid tool arguments should remain visible for diagnosis"
	)

	dock._handle_event(_runtime_event("reasoning.summary.delta", "m3", {"delta": "**Checked the scene.**"}))
	dock._handle_event(_runtime_event("message.completed", "m3", {"text": "Finished."}))
	var reasoning_view: Dictionary = dock._message_views_by_item_id["m3"]
	_assert(
		(reasoning_view.reasoning_body as RichTextLabel).get_parsed_text() == "Checked the scene.",
		"Reasoning Markdown should be safely rendered without visible markers"
	)
	_assert(
		(reasoning_view.reasoning_body as RichTextLabel).visible,
		"Progress summaries should remain visible in the turn timeline"
	)
	_assert(not reasoning_view.has("reasoning_toggle"), "Each provider step must not create another Thinking toggle")
	_assert(
		(reasoning_view.body as RichTextLabel).get_parsed_text() == "Finished.",
		"Final answer should remain separate"
	)
	dock._handle_event(_runtime_event("turn.completed", "", {"status": "completed"}))
	_assert(activity_label.text.begins_with("Worked for "), "Completed task should retain its elapsed activity")
	var timeline_count_after_completion := activity_timeline.get_child_count()
	dock._handle_event(_runtime_event("reasoning.summary.delta", "late", {"delta": "Late summary"}))
	_assert(
		activity_timeline.get_child_count() == timeline_count_after_completion,
		"Completed turns should ignore stale reasoning events"
	)

	var wheel_up := InputEventMouseButton.new()
	wheel_up.button_index = MOUSE_BUTTON_WHEEL_UP
	wheel_up.pressed = true
	dock._conversation_following = true
	dock._on_conversation_scroll_input(wheel_up)
	_assert(not dock._conversation_following, "Scrolling upward should pause conversation following")
	dock._queue_scroll_to_bottom(true)
	_assert(dock._conversation_following, "Requesting scroll-to-bottom should resume conversation following")
	_assert(dock._scroll_settle_frames > 0, "Resuming follow should schedule layout settling")

	dock._server_ready = true
	dock._models_ready = true
	dock._sessions_ready = true
	dock._model_capabilities[dock._selected_model()] = {"image_input": true}
	dock._prompt.text = ""
	var attachment_id := "b".repeat(64)
	dock._on_visual_attachment_ready({
		"ok": true,
		"attachment": {
			"attachment_id": attachment_id,
			"mime_type": "image/png",
			"width": 640,
			"height": 360,
			"size_bytes": 1024,
			"detail": "high",
			"source": "clipboard",
			"name": "pasted.png",
			"annotated_from": "a".repeat(64),
			"annotations": [{
				"id": 1,
				"type": "arrow",
				"start": [0.1, 0.2],
				"end": [0.8, 0.7],
			}],
			"local_path": "must-not-cross-protocol",
		},
	})
	_assert(dock._pending_attachments.size() == 1, "A valid image should enter the composer queue")
	_assert(dock._attachment_scroll.visible, "Pending images should reveal the attachment strip")
	_assert(not dock._send_button.disabled, "An image-only ready composer should enable Send")
	var attachment_chip := dock._attachment_list.get_child(0)
	var annotation_button := attachment_chip.get_child(0) as TextureButton
	_assert(
		annotation_button != null and annotation_button.tooltip_text == "Annotate image",
		"Clicking a pending image should open its annotation editor"
	)
	var remove_button := attachment_chip.get_child(attachment_chip.get_child_count() - 1) as Button
	var remove_is_deferred := false
	_assert(remove_button != null, "Attachment chips should expose a remove button")
	if remove_button != null:
		for connection in remove_button.pressed.get_connections():
			if (int(connection.get("flags", 0)) & CONNECT_DEFERRED) != 0:
				remove_is_deferred = true
	_assert(remove_is_deferred, "Attachment removal must run after its button signal finishes")
	var protocol_attachments := dock._attachment_protocol_refs(dock._pending_attachments)
	_assert(
		protocol_attachments.size() == 1
		and not (protocol_attachments[0] as Dictionary).has("local_path"),
		"Composer protocol refs must not expose local attachment paths"
	)
	_assert(
		((protocol_attachments[0] as Dictionary).get("annotations", []) as Array).size() == 1
		and (protocol_attachments[0] as Dictionary).get("annotated_from") == "a".repeat(64),
		"Composer protocol refs should preserve bounded annotation semantics and provenance"
	)
	var replacement_id := "d".repeat(64)
	_assert(dock._replace_pending_attachment(attachment_id, {
		"ok": true,
		"attachment": {
			"attachment_id": replacement_id,
			"mime_type": "image/png",
			"width": 640,
			"height": 360,
			"size_bytes": 2048,
			"detail": "high",
			"source": "clipboard",
			"annotations": [{
				"id": 1,
				"type": "rectangle",
				"start": [0.2, 0.2],
				"end": [0.6, 0.6],
			}],
		},
	}), "Saving annotations should replace the pending attachment in place")
	attachment_id = replacement_id
	_assert(
		str(dock._pending_attachments[0].get("attachment_id", "")) == replacement_id,
		"Annotation replacement should retain the pending attachment position"
	)
	dock._model_capabilities[dock._selected_model()] = {"image_input": false}
	dock._update_controls()
	_assert(
		dock._send_button.disabled and dock._attachment_menu.disabled,
		"A model that explicitly rejects image input should block visual messages"
	)
	dock._model_capabilities[dock._selected_model()] = {"image_input": true}
	dock._remove_attachment(attachment_id)
	_assert(dock._pending_attachments.is_empty(), "Removing an attachment should clear its pending ref")
	dock._prompt.text = "Next task"
	dock._update_controls()
	_assert(not dock._send_button.disabled, "Non-empty ready composer should enable Send")
	dock._turn_in_progress = true
	dock._update_controls()
	_assert(not dock._send_button.visible and dock._stop_button.visible, "Stop should replace Send while running")
	_assert(dock._clear_button.disabled, "Clear should not discard a running turn")
	_assert(dock._approval_mode_select.disabled, "Approval mode should be frozen while a task is running")
	dock._turn_in_progress = false
	dock._update_controls()
	_assert(not dock._approval_mode_select.disabled, "Approval mode should unlock after a task finishes")
	dock._clear_conversation()
	_assert(dock._conversation.get_child_count() == 0, "Clear should remove every message")
	_assert(dock._message_views_by_item_id.is_empty(), "Clear should release assistant views")
	_assert(dock._tool_views_by_item_id.is_empty(), "Clear should release tool views")
	_assert(dock._delta_buffer.is_empty(), "Clear should reset text streaming")
	_assert(dock._reasoning_delta_buffer.is_empty(), "Clear should reset reasoning streaming")

	dock._render_session_snapshot({
		"session_id": "session_history",
		"title": "Saved task",
		"turns": [{
			"turn_id": "turn_history",
			"prompt": "恢复这个任务",
			"attachments": [{
				"attachment_id": "c".repeat(64),
				"mime_type": "image/png",
				"width": 320,
				"height": 180,
				"size_bytes": 256,
				"detail": "low",
				"source": "project_resource",
				"name": "history.png",
			}],
			"status": "completed",
			"duration_ms": 2500,
			"usage": {"input_tokens": 120, "output_tokens": 30, "total_tokens": 150},
			"context": {
				"history_characters": 42000,
				"context_characters": 18000,
				"dropped_messages": 3,
				"compacted_tool_messages": 2,
				"context_compacted": true,
			},
			"entries": [
				{
					"kind": "context",
					"item_id": "history_context",
					"data": {
						"source_count": 1,
						"character_count": 320,
						"index_revision": "history-revision",
						"sources": [{
							"path": "demo/main.gd",
							"line": 2,
							"reasons": ["current_script"],
							"symbols": [],
						}],
					},
				},
				{
					"kind": "assistant",
					"item_id": "history_message",
					"reasoning": "历史思考摘要",
					"text": "历史回答",
				},
				{
					"kind": "tool",
					"item_id": "history_tool",
					"name": "read_file",
					"arguments": {"path": "main.gd"},
					"output": {"ok": true, "content": "extends Node"},
				},
			],
		}],
	})
	_assert(dock._message_views_by_item_id.has("history_message"), "Saved assistant messages should restore")
	_assert(dock._tool_views_by_item_id.has("history_tool"), "Saved tool records should restore")
	_assert(dock._tool_views_by_item_id.has("history_context"), "Saved project context cards should restore")
	var history_view: Dictionary = dock._message_views_by_item_id.get("history_message", {})
	_assert(str(history_view.get("body_text", "")) == "历史回答", "Saved assistant text should be restored")
	_assert(str(history_view.get("reasoning_text", "")) == "历史思考摘要", "Saved reasoning should be restored")
	_assert(_has_label_text(dock._conversation, "history.png"), "Saved visual attachments should be restored")
	var restored_usage_label := _find_label_containing(dock._conversation, "18.0K")
	_assert(restored_usage_label != null, "Saved context usage should be restored")
	if restored_usage_label != null:
		_assert("42000" in restored_usage_label.tooltip_text, "Saved context history should be available in the tooltip")

	dock._session_id = "session_selected"
	dock._turn_in_progress = true
	dock._active_turn_id = "turn_selected"
	dock._delta_buffer = ""
	var foreign_event := _runtime_event("message.delta", "foreign_item", {"delta": "must not render"}, "turn_selected")
	foreign_event["session_id"] = "session_other"
	dock._handle_event(foreign_event)
	_assert(dock._delta_buffer.is_empty(), "Events from another conversation must not render")
	dock._turn_in_progress = false

	dock._sessions_ready = false
	dock._sessions_ready_before_sync = true
	dock._session_sync_in_flight = true
	dock._session_get_target_id = "session_other"
	dock._pending["session-get-invalid"] = "session.get"
	dock._handle_response({
		"id": "session-get-invalid",
		"result": {"session": {"session_id": "session_unexpected", "turns": []}},
	})
	_assert(dock._session_id == "session_selected", "Invalid session snapshots must not replace the current conversation")
	_assert(dock._sessions_ready, "A failed conversation switch should restore the previous ready state")
	_assert(dock._message_views_by_item_id.has("history_message"), "A failed switch must preserve the visible conversation")

	dock._session_id = "session_stale_saved"
	dock._sessions_ready = false
	dock._sessions_ready_before_sync = false
	dock._session_sync_in_flight = true
	dock._pending["session-list-cold-failure"] = "session.list"
	dock._handle_response({
		"id": "session-list-cold-failure",
		"error": {"message": "offline"},
	})
	_assert(not dock._sessions_ready, "An unverified saved conversation must stay disabled after cold-start sync failure")

	dock._session_id = "session_deleted_elsewhere"
	dock._sessions_ready = true
	dock._sessions_ready_before_sync = true
	dock._session_sync_in_flight = true
	dock._session_list_restore_view = false
	dock._pending["session-list-deleted"] = "session.list"
	dock._handle_response({
		"id": "session-list-deleted",
		"result": {"sessions": [{
			"session_id": "session_remaining",
			"title": "Remaining",
		}]},
	})
	_assert(dock._session_id.is_empty(), "A conversation deleted elsewhere must not remain the active target")
	_assert(dock._session_get_target_id == "session_remaining", "Refresh should select an available fallback conversation")
	_assert(not dock._sessions_ready, "The fallback conversation must load before sending is enabled")
	dock._capture_session_diagnostics({"diagnostics": [{
		"filename": "session_corrupt00.json",
		"code": "corrupt",
	}]})
	dock._flush_session_diagnostics()
	_assert(
		_has_label_text(
			dock._conversation,
			"Saved conversation session_corrupt00.json could not be loaded: Snapshot is corrupt"
		),
		"Corrupt saved conversations should produce a visible diagnostic"
	)
	var pagination_turns: Array = []
	for index in range(45):
		pagination_turns.append({
			"turn_id": "turn_%d" % index,
			"prompt": "Prompt %d" % index,
			"entries": [],
		})
	var history_pages := dock._paginate_session_turns(pagination_turns)
	_assert(history_pages.size() == 2, "Long saved conversations should be split into bounded history pages")
	_assert((history_pages[0] as Array).size() == 40, "The newest history page should honor the turn limit")
	_assert((history_pages[1] as Array).size() == 5, "Earlier turns should remain accessible on another page")
	dock._render_session_snapshot({"session_id": "session_pages", "turns": pagination_turns})
	dock._show_session_history_page(1)
	_assert(dock._session_history_page == 1, "Earlier history should be selectable")
	dock._return_to_latest_session_history()
	_assert(dock._session_history_page == 0, "Submitting from history should return to the newest page")
	_assert(_has_label_text(dock._conversation, "Prompt 44"), "The newest timeline should be visible before a live turn is appended")
	_assert(
		dock._normalize_script_source("line 1\r\nline 2\r") == "line 1\nline 2\n",
		"Script save checks should ignore platform newline differences"
	)
	_assert(
		dock._runtime_file_resource_path("demo\\main.gd") == "res://demo/main.gd"
		and dock._runtime_file_resource_path("res://demo/main.gd") == "res://demo/main.gd",
		"Runtime file paths should normalize to one res:// path"
	)
	_assert(
		dock._is_godetx_plugin_resource_path("res://addons/godetx/godetx_dock.gd")
		and not dock._is_godetx_plugin_resource_path("res://addons/godetx_extra/example.gd"),
		"Only GodotX plugin files should require a plugin reload"
	)
	var dock_source := FileAccess.get_file_as_string("res://addons/godetx/godetx_dock.gd")
	_assert(
		not dock_source.contains("activate_item_by_event")
		and not dock_source.contains("reload_open_files")
		and not dock_source.contains("save_all_scripts"),
		"The running Dock must not synchronously save or reload itself through private editor UI"
	)
	_assert(
		dock_source.contains("execute_deferred")
		and dock_source.contains("DEFERRED_EDITOR_TOOL_TIMEOUT_SECONDS")
		and not dock_source.contains("png_base64")
		and not dock_source.contains("raw_to_base64"),
		"Game screenshots should respond asynchronously by attachment ID without WebSocket Base64"
	)
	_assert(
		dock_source.find("if event_type == \"editor.tool.request\":")
		< dock_source.find("if TURN_SCOPED_EVENTS.has(event_type):"),
		"Editor tool control requests must be handled before UI turn-event filtering"
	)
	_assert(
		dock_source.contains("SYNC_EDITOR_TOOL_TIMEOUT_SECONDS")
		and dock_source.contains("EDITOR_TOOL_HOST_TIMEOUT")
		and dock_source.contains("socket.outbound_buffer_size = SOCKET_BUFFER_SIZE")
		and dock_source.contains("var send_error: Error = _socket.send_text"),
		"Editor tool responses should have a host watchdog and checked outbound transport"
	)
	dock.shutdown()
	_assert(dock._shutting_down and not dock.is_processing(), "Shutdown should stop Dock processing before it is freed")

	dock.free()
	Localization.uninstall()
	if not _failures.is_empty():
		for failure in _failures:
			printerr(failure)
		quit(1)
		return
	print("GODETX_CHAT_UI_OK")
	quit(0)


func _key_event(keycode: Key, pressed: bool = true, shifted: bool = false, repeated: bool = false) -> InputEventKey:
	var event := InputEventKey.new()
	event.keycode = keycode
	event.pressed = pressed
	event.shift_pressed = shifted
	event.echo = repeated
	return event


func _runtime_event(type: String, item_id: String, data: Dictionary, turn_id: String = "turn_ui") -> Dictionary:
	return {
		"version": 1,
		"type": type,
		"turn_id": turn_id,
		"item_id": item_id,
		"data": data,
	}


func _capture_image_completion(result: Dictionary) -> void:
	_captured_image_completion = result.duplicate(true)


func _has_label_text(root_node: Node, expected: String) -> bool:
	var label := root_node as Label
	if label != null and label.text == expected:
		return true
	for child in root_node.get_children():
		if _has_label_text(child, expected):
			return true
	return false


func _count_label_text(root_node: Node, expected: String) -> int:
	var count := 0
	var label := root_node as Label
	if label != null and label.text == expected:
		count += 1
	for child in root_node.get_children():
		count += _count_label_text(child, expected)
	return count


func _has_button_text(root_node: Node, expected: String) -> bool:
	var button := root_node as Button
	if button != null and button.text == expected:
		return true
	for child in root_node.get_children():
		if _has_button_text(child, expected):
			return true
	return false


func _find_label_containing(root_node: Node, expected: String) -> Label:
	var label := root_node as Label
	if label != null and expected in label.text:
		return label
	for child in root_node.get_children():
		var found := _find_label_containing(child, expected)
		if found != null:
			return found
	return null


func _assert(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)
