@tool
extends VBoxContainer

signal image_capabilities_received(capabilities: Dictionary)
signal image_generation_completed(result: Dictionary)
signal image_generation_failed(generation_id: String, message: String)
signal image_workflow_progress(progress: Dictionary)
signal ui_kit_completed(result: Dictionary)
signal skillx_snapshot_received(snapshot: Dictionary)
signal skillx_skill_received(skill: Dictionary)
signal skillx_index_received(index: Dictionary)
signal skillx_operation_failed(method: String, message: String)

const DEFAULT_BASE_URL := "https://ptai.cc/v1"
const DEFAULT_MODEL := "gpt-5.6-sol"
const DEFAULT_PROVIDER := "openai-compatible"
const BUNDLED_RUNTIME_SERVER := "res://addons/godetx/runtime/dist/src/server.js"
const DEVELOPMENT_RUNTIME_SERVER := "res://runtime/dist/src/server.js"
const BUNDLED_WINDOWS_NODE_CANDIDATES := [
	"res://addons/godetx/bin/windows-x64/node.exe",
	"res://addons/godetx/bin/windows-arm64/node.exe",
	"res://addons/godetx/bin/windows-ia32/node.exe",
]
const MODEL_LABEL_MAX_LENGTH := 48
const SETTINGS_ROOT := "godetx/projects"
const SETTINGS_SCHEMA_VERSION := 4
const SETTING_SCHEMA_VERSION := "schema_version"
const SETTING_SELECTED_PROVIDER := "selected_provider"
const SETTING_BASE_URL := "base_url"
const SETTING_API_KEY := "api_key"
const SETTING_REMEMBER_API_KEY := "remember_api_key"
const SETTING_AUTO_APPROVE_EDITS := "auto_approve_edits"
const SETTING_RUNTIME_AUTOMATION_ENABLED := "runtime_automation_enabled"
const SETTING_SELECTED_SESSION_ID := "selected_session_id"
const APPROVAL_MODE_ASK := "ask"
const APPROVAL_MODE_AUTO_EDITS := "auto_edits"
const APPROVAL_LABEL_ASK := "Ask for approval"
const APPROVAL_LABEL_AUTO_EDITS := "Approve for me"
const PROMPT_KEY_PASS := 0
const PROMPT_KEY_CONSUME := 1
const PROMPT_KEY_SUBMIT := 2
const TOOL_OUTPUT_LIMIT := 65536
const EDITOR_TOOL_RESULT_LIMIT := 2_000_000
const SOCKET_BUFFER_SIZE := 8 * 1024 * 1024
const RUNTIME_CONNECT_WARNING_MS := 8_000
const SYNC_EDITOR_TOOL_TIMEOUT_SECONDS := 2.0
const DEFERRED_EDITOR_TOOL_TIMEOUT_SECONDS := 12.0
const GAME_TEST_LOG_ENTRY_LIMIT := 12
const GAME_TEST_LOG_LINE_LIMIT := 512
const TOOL_DETAIL_MIN_HEIGHT := 44.0
const TOOL_DETAIL_ARGUMENTS_MAX_HEIGHT := 120.0
const TOOL_DETAIL_MAX_HEIGHT := 220.0
const TOOL_DETAIL_DIFF_MAX_HEIGHT := 280.0
const SCROLL_SETTLE_FRAMES := 6
const SCROLL_INPUT_SETTLE_FRAMES := 6
const SCROLL_BOTTOM_THRESHOLD := 32.0
const MAX_TURN_OPEN_SCENE_PATHS := 128
const SCENE_ERROR_SUFFIX := ". No editor scene operation was executed."
const GODETX_PLUGIN_ROOT := "res://addons/godetx/"
const SESSION_MENU_RENAME := 1
const SESSION_MENU_DELETE := 2
const ATTACHMENT_MENU_FILE := 1
const ATTACHMENT_MENU_PROJECT_RESOURCE := 2
const ATTACHMENT_MENU_VIEWPORT_2D := 3
const ATTACHMENT_MENU_VIEWPORT_3D := 4
const IMAGE_CAPABILITY_UNKNOWN := -1
const IMAGE_CAPABILITY_UNSUPPORTED := 0
const IMAGE_CAPABILITY_SUPPORTED := 1
const SESSION_RENDER_TURN_LIMIT := 40
const SESSION_RENDER_ENTRY_LIMIT := 600
const SCENE_BOUND_EDITOR_TOOLS := {
	"scene_get_tree": true,
	"editor_get_selection": true,
	"node_get_properties": true,
	"scene_apply_operations": true,
}
const TURN_SCOPED_EVENTS := {
	"turn.started": true,
	"context.prepared": true,
	"message.delta": true,
	"reasoning.summary.delta": true,
	"message.completed": true,
	"tool.started": true,
	"tool.output.delta": true,
	"tool.completed": true,
	"approval.requested": true,
	"approval.resolved": true,
	"file_change.proposed": true,
	"file_change.applied": true,
	"editor_change.proposed": true,
	"editor_change.applied": true,
	"editor.tool.request": true,
	"provider.fallback": true,
	"usage.updated": true,
	"turn.completed": true,
	"turn.failed": true,
}
const GODETX_MARK := preload("res://addons/godetx/icons/godotx-mark.png")
const EditorBridge := preload("res://addons/godetx/editor_bridge.gd")
const AttachmentStore := preload("res://addons/godetx/attachment_store.gd")
const VisualCapture := preload("res://addons/godetx/visual_capture.gd")
const ResourceDropTarget := preload("res://addons/godetx/resource_drop_target.gd")
const ImageAnnotationEditor := preload("res://addons/godetx/image_annotation_editor.gd")
const Localization := preload("res://addons/godetx/localization.gd")
const MarkdownRenderer := preload("res://addons/godetx/markdown_renderer.gd")
const PROJECT_VISUAL_RESOURCE_EXTENSIONS := [
	"png", "jpg", "jpeg", "webp", "bmp", "tga", "svg",
	"tres", "res", "material", "mesh", "tscn", "scn",
]
const ICONS := {
	"Clear": preload("res://addons/godetx/icons/clear.svg"),
	"Reload": preload("res://addons/godetx/icons/refresh.svg"),
	"Tools": preload("res://addons/godetx/icons/settings.svg"),
	"Stop": preload("res://addons/godetx/icons/stop.svg"),
	"Play": preload("res://addons/godetx/icons/send.svg"),
	"Progress1": preload("res://addons/godetx/icons/thinking.svg"),
	"Progress2": preload("res://addons/godetx/icons/thinking.svg"),
	"Progress3": preload("res://addons/godetx/icons/thinking.svg"),
	"StatusSuccess": preload("res://addons/godetx/icons/success.svg"),
	"StatusError": preload("res://addons/godetx/icons/error.svg"),
	"GodotX": GODETX_MARK,
	"SceneTask": preload("res://addons/godetx/icons/tool-scene.png"),
	"CodeTask": preload("res://addons/godetx/icons/tool-code.png"),
	"ProjectTask": preload("res://addons/godetx/icons/tool-project.png"),
	"WebTask": preload("res://addons/godetx/icons/search.svg"),
	"AgentTask": preload("res://addons/godetx/icons/tool-agent.png"),
	"Info": preload("res://addons/godetx/icons/info.svg"),
	"File": preload("res://addons/godetx/icons/file.svg"),
	"Edit": preload("res://addons/godetx/icons/edit.svg"),
	"Remove": preload("res://addons/godetx/icons/clear.svg"),
	"GuiTreeArrowRight": preload("res://addons/godetx/icons/chevron-right.svg"),
	"GuiTreeArrowDown": preload("res://addons/godetx/icons/chevron-down.svg"),
}

var editor_interface: EditorInterface
var editor_undo_redo: EditorUndoRedoManager
var editor_game_debugger
var _editor_bridge

var _socket := WebSocketPeer.new()
var _runtime_pid := -1
var _request_id := 0
var _pending: Dictionary = {}
var _image_generation_requests: Dictionary = {}
var _image_context_captures: Dictionary = {}
var _session_id := ""
var _session_summaries: Array = []
var _sessions_ready := false
var _sessions_ready_before_sync := false
var _session_sync_in_flight := false
var _session_list_restore_view := false
var _session_create_purpose := ""
var _session_get_target_id := ""
var _session_get_refresh_only := false
var _session_snapshot: Dictionary = {}
var _session_history_page := 0
var _session_diagnostic_fingerprint := ""
var _pending_session_diagnostics := PackedStringArray()
var _configured_fingerprint := ""
var _configure_fingerprint_pending := ""
var _configure_purpose := ""
var _reported_connection_notice_key := ""
var _queued_prompt := ""
var _queued_turn_active := false
var _queued_model := ""
var _queued_reasoning := ""
var _queued_runtime_automation_enabled := false
var _queued_attachments: Array[Dictionary] = []
var _queued_editor_context: Dictionary = {}
var _pending_turn_scene_context: Dictionary = {}
var _turn_scene_contexts: Dictionary = {}
var _reconnect_at := 0
var _connected := false
var _server_ready := false
var _turn_in_progress := false
var _model_sync_in_flight := false
var _models_ready := false
var _models_ready_before_sync := false
var _models_provider_id := ""
var _delta_buffer := ""
var _delta_item_id := ""
var _reasoning_delta_buffer := ""
var _reasoning_item_id := ""
var _next_delta_flush := 0
var _message_had_delta := false
var _message_items_with_deltas: Dictionary = {}
var _message_views_by_item_id: Dictionary = {}
var _tool_views_by_item_id: Dictionary = {}
var _conversation_following := true
var _scroll_settle_frames := 0
var _scroll_input_settle_frames := 0
var _activity_root: VBoxContainer
var _activity_row: HBoxContainer
var _activity_timeline: VBoxContainer
var _activity_icon: TextureRect
var _activity_label: Label
var _activity_usage_label: Label
var _active_turn_id := ""
var _activity_phase := ""
var _activity_started_at := 0
var _activity_animation_step := -1
var _runtime_port := 0
var _workspace_path := ""
var _auth_token := ""
var _auth_token_hash := ""
var _runtime_start_requested_at_ms := 0
var _runtime_start_warning_reported := false
var _shutting_down := false
var _plugin_reload_required := false
var _unsaved_open_script_paths := PackedStringArray()

var _base_url_value := DEFAULT_BASE_URL
var _api_key_value := ""
var _remember_api_key_enabled := true
var _auto_approve_edits_enabled := false
var _runtime_automation_enabled := false
var _provider_id := DEFAULT_PROVIDER
var _provider_descriptors: Dictionary = {}
var _provider_configs: Dictionary = {}
var _provider_remember_secrets: Dictionary = {}
var _providers_ready := false
var _provider_sync_in_flight := false
var _settings_provider_id := DEFAULT_PROVIDER
var _settings_provider_drafts: Dictionary = {}
var _settings_remember_drafts: Dictionary = {}
var _model_capabilities: Dictionary = {}
var _model_select: OptionButton
var _reasoning_select: OptionButton
var _approval_mode_select: OptionButton
var _settings_button: Button
var _refresh_models_button: Button
var _settings_dialog: ConfirmationDialog
var _settings_provider_select: OptionButton
var _settings_dynamic_fields: GridContainer
var _settings_legacy_fields: GridContainer
var _settings_config_controls: Dictionary = {}
var _settings_base_url: LineEdit
var _settings_api_key: LineEdit
var _remember_api_key: CheckButton
var _auto_approve_edits: CheckButton
var _runtime_automation: CheckButton
var _conversation_scroll: ScrollContainer
var _conversation: VBoxContainer
var _composer: PanelContainer
var _composer_drop_target
var _prompt: TextEdit
var _attachment_menu: MenuButton
var _attachment_scroll: ScrollContainer
var _attachment_list: HBoxContainer
var _attachment_file_dialog: FileDialog
var _attachment_project_dialog: EditorFileDialog
var _annotation_dialog: Window
var _annotation_editor
var _annotation_tool_group: ButtonGroup
var _annotation_tool_buttons: Array[Button] = []
var _annotation_undo_button: Button
var _annotation_clear_button: Button
var _annotation_save_button: Button
var _annotation_cancel_button: Button
var _annotation_target: Dictionary = {}
var _annotation_edit_token := 0
var _annotation_saving := false
var _send_button: Button
var _stop_button: Button
var _status: Label
var _status_dot: PanelContainer
var _clear_button: Button
var _session_select: OptionButton
var _session_menu: MenuButton
var _rename_session_dialog: ConfirmationDialog
var _rename_session_input: LineEdit
var _delete_session_dialog: ConfirmationDialog
var _approval_dialog: ConfirmationDialog
var _approval_diff: TextEdit
var _approval_request_id := ""
var _approval_category := ""
var _approval_change_id := ""
var _approval_turn_id := ""
var _approval_preview: Dictionary = {}
var _editor_scene_write_grants: Dictionary = {}
var _deferred_editor_tool_requests: Dictionary = {}
var _pending_editor_tool_responses: Dictionary = {}
var _attachment_store
var _visual_capture
var _pending_attachments: Array[Dictionary] = []
var _pending_visual_imports := 0


func _ready() -> void:
	name = "GodotXDock"
	_shutting_down = false
	_plugin_reload_required = false
	set_process(true)
	_workspace_path = ProjectSettings.globalize_path("res://").trim_suffix("/").trim_suffix("\\")
	_runtime_port = 30000 + absi(_workspace_path.hash()) % 20000
	_auth_token = Crypto.new().generate_random_bytes(32).hex_encode()
	var hashing := HashingContext.new()
	hashing.start(HashingContext.HASH_SHA256)
	hashing.update(_auth_token.to_utf8_buffer())
	_auth_token_hash = hashing.finish().hex_encode()
	_configure_socket(_socket)
	_load_persisted_connection_settings()
	_ensure_visual_services()
	_build_ui()
	_editor_bridge = EditorBridge.new(
		editor_interface,
		editor_undo_redo,
		editor_game_debugger,
		_runtime_automation_enabled
	)
	_start_runtime()


func imagex_state() -> Dictionary:
	var descriptor_value: Variant = _provider_descriptors.get(_provider_id, {})
	var descriptor: Dictionary = descriptor_value if descriptor_value is Dictionary else {}
	var fingerprint := _connection_fingerprint()
	var planner_model := _selected_model()
	if planner_model.is_empty():
		planner_model = _default_model_for_provider()
	return {
		"ready": (
			not _shutting_down
			and _server_ready
			and _socket.get_ready_state() == WebSocketPeer.STATE_OPEN
			and not fingerprint.is_empty()
			and _configured_fingerprint == fingerprint
		),
		"provider_id": _provider_id,
		"provider_name": str(descriptor.get("display_name", _provider_id)),
		"planner_model": planner_model,
		"fingerprint": fingerprint,
		"settings_complete": _provider_config_is_complete(_provider_id, _provider_config(_provider_id)),
	}


func skillx_state() -> Dictionary:
	return {
		"ready": (
			not _shutting_down
			and _server_ready
			and _socket.get_ready_state() == WebSocketPeer.STATE_OPEN
		),
	}


func request_skillx_snapshot(refresh: bool = false) -> Dictionary:
	if not bool(skillx_state().get("ready", false)):
		return {"ok": false, "error": _t("Runtime is not connected.")}
	var method := "skills.refresh" if refresh else "skills.list"
	var request_id := _send_request(method, {})
	return {"ok": not request_id.is_empty(), "request_id": request_id}


func request_skillx_skill(skill_id: String) -> Dictionary:
	if skill_id.is_empty():
		return {"ok": false, "error": _t("Select a skill first")}
	var request_id := _send_request("skills.get", {"id": skill_id})
	return {"ok": not request_id.is_empty(), "request_id": request_id}


func save_skillx_skill(params: Dictionary) -> Dictionary:
	var request_id := _send_request("skills.save", params)
	return {"ok": not request_id.is_empty(), "request_id": request_id}


func delete_skillx_skill(skill_id: String) -> Dictionary:
	if skill_id.is_empty():
		return {"ok": false, "error": _t("Select a skill first")}
	var request_id := _send_request("skills.delete", {"id": skill_id})
	return {"ok": not request_id.is_empty(), "request_id": request_id}


func set_skillx_skill_enabled(skill_id: String, enabled: bool) -> Dictionary:
	if skill_id.is_empty():
		return {"ok": false, "error": _t("Select a skill first")}
	var request_id := _send_request("skills.set_enabled", {
		"id": skill_id,
		"enabled": enabled,
	})
	return {"ok": not request_id.is_empty(), "request_id": request_id}


func rebuild_skillx_index() -> Dictionary:
	var request_id := _send_request("index.rebuild", {})
	return {"ok": not request_id.is_empty(), "request_id": request_id}


func request_image_capabilities() -> Dictionary:
	var state := imagex_state()
	if not bool(state.get("ready", false)):
		return {"ok": false, "error": _t("Image runtime is not ready")}
	var request_id := _send_request("image.capabilities", {})
	return {
		"ok": not request_id.is_empty(),
		"request_id": request_id,
		"error": "" if not request_id.is_empty() else _t("Runtime is not connected."),
	}


func import_imagex_project_resource(path: String, completed: Callable) -> void:
	if not completed.is_valid():
		return
	if _shutting_down:
		completed.call({"ok": false, "error": _t("Image runtime is unavailable")})
		return
	_ensure_visual_services()
	if _visual_capture == null:
		completed.call({"ok": false, "error": _t("Source image could not be imported")})
		return
	_visual_capture.import_project_resource(path, completed)


func load_imagex_attachment_preview(attachment: Dictionary) -> Texture2D:
	if _shutting_down:
		return null
	_ensure_visual_services()
	return _attachment_store.load_preview(attachment) if _attachment_store != null else null


func request_image_generation(params: Dictionary) -> Dictionary:
	var state := imagex_state()
	if not bool(state.get("ready", false)):
		return {"ok": false, "error": _t("Image runtime is not ready")}
	var generation_id := str(params.get("generation_id", ""))
	if generation_id.is_empty():
		return {"ok": false, "error": _t("Image generation ID is required")}
	if _image_generation_requests.values().has(generation_id) or _image_context_captures.has(generation_id):
		return {"ok": false, "error": _t("An image is already being generated")}
	var request_id := _send_request("image.generate", params)
	if request_id.is_empty():
		return {"ok": false, "error": _t("Runtime is not connected.")}
	_image_generation_requests[request_id] = generation_id
	_update_controls()
	return {"ok": true, "request_id": request_id, "generation_id": generation_id}


func request_image_edit(params: Dictionary) -> Dictionary:
	var state := imagex_state()
	if not bool(state.get("ready", false)):
		return {"ok": false, "error": _t("Image runtime is not ready")}
	var generation_id := str(params.get("generation_id", ""))
	if generation_id.is_empty():
		return {"ok": false, "error": _t("Image generation ID is required")}
	var source_attachment_id := str(params.get("source_attachment_id", ""))
	if not AttachmentStore.is_safe_attachment_id(source_attachment_id):
		return {"ok": false, "error": _t("Source image is invalid")}
	var mode := str(params.get("mode", ""))
	if mode != "reskin" and mode != "atlas_variation":
		return {"ok": false, "error": _t("Image edit mode is invalid")}
	if not _image_generation_requests.is_empty() or not _image_context_captures.is_empty():
		return {"ok": false, "error": _t("An image is already being generated")}
	var request_id := _send_request("image.edit", params)
	if request_id.is_empty():
		return {"ok": false, "error": _t("Runtime is not connected.")}
	_image_generation_requests[request_id] = generation_id
	_update_controls()
	return {"ok": true, "request_id": request_id, "generation_id": generation_id}


func request_ui_kit_generation(params: Dictionary) -> Dictionary:
	var state := imagex_state()
	if not bool(state.get("ready", false)):
		return {"ok": false, "error": _t("Image runtime is not ready")}
	var workflow_id := str(params.get("workflow_id", ""))
	if workflow_id.is_empty():
		return {"ok": false, "error": _t("Image generation ID is required")}
	if not _image_generation_requests.is_empty() or not _image_context_captures.is_empty():
		return {"ok": false, "error": _t("An image is already being generated")}
	var request_params := params.duplicate(true)
	var capture_viewport := bool(request_params.get("capture_viewport", true))
	request_params.erase("capture_viewport")
	request_params["context"] = _collect_imagex_project_context()
	if capture_viewport and _visual_capture != null:
		_image_context_captures[workflow_id] = request_params
		image_workflow_progress.emit({
			"workflow_id": workflow_id,
			"phase": "capturing",
			"message": _t("Capturing Godot context"),
		})
		_update_controls()
		_visual_capture.capture_editor_viewport(
			"2d",
			0,
			Callable(self, "_on_imagex_ui_context_captured").bind(workflow_id)
		)
		return {"ok": true, "workflow_id": workflow_id, "capturing": true}
	return _dispatch_ui_kit_generation(request_params)


func _on_imagex_ui_context_captured(result: Dictionary, workflow_id: String) -> void:
	var params_value: Variant = _image_context_captures.get(workflow_id)
	_image_context_captures.erase(workflow_id)
	if not params_value is Dictionary:
		_update_controls()
		return
	var request_params: Dictionary = params_value
	var context_value: Variant = request_params.get("context", {})
	var context: Dictionary = {}
	if context_value is Dictionary:
		context = context_value as Dictionary
	else:
		request_params["context"] = context
	if bool(result.get("ok", false)):
		var attachment_value: Variant = result.get("attachment")
		if attachment_value is Dictionary:
			var attachment: Dictionary = AttachmentStore.metadata_reference(attachment_value as Dictionary)
			var attachment_id: String = str(attachment.get("attachment_id", ""))
			var expected_scene_id: String = str(context.get("scene_id", ""))
			var captured_scene_id: String = str(attachment.get("scene_id", ""))
			if not expected_scene_id.is_empty() and captured_scene_id != expected_scene_id:
				context["viewport_capture_error"] = "The active scene changed before viewport capture completed"
			elif AttachmentStore.is_safe_attachment_id(attachment_id):
				request_params["context_attachment_id"] = attachment_id
	else:
		context["viewport_capture_error"] = str(result.get("error", ""))
	_dispatch_ui_kit_generation(request_params)


func _dispatch_ui_kit_generation(params: Dictionary) -> Dictionary:
	var workflow_id := str(params.get("workflow_id", ""))
	var request_id := _send_request("ui_kit.generate", params)
	if request_id.is_empty():
		image_generation_failed.emit(workflow_id, _t("Runtime is not connected."))
		_update_controls()
		return {"ok": false, "error": _t("Runtime is not connected.")}
	_image_generation_requests[request_id] = workflow_id
	_update_controls()
	return {"ok": true, "request_id": request_id, "workflow_id": workflow_id}


func cancel_image_generation(generation_id: String) -> void:
	if generation_id.is_empty():
		return
	if _image_context_captures.has(generation_id):
		_image_context_captures.erase(generation_id)
		image_generation_failed.emit(generation_id, _t("UI kit generation was cancelled"))
		_update_controls()
		return
	_send_request("image.cancel", {"generation_id": generation_id})


func _collect_imagex_project_context() -> Dictionary:
	var context: Dictionary = {
		"project_name": str(ProjectSettings.get_setting("application/config/name", "Godot project")),
		"scene_id": "",
		"scene_path": "",
		"scene_root": "",
		"viewport_width": int(ProjectSettings.get_setting("display/window/size/viewport_width", 1152)),
		"viewport_height": int(ProjectSettings.get_setting("display/window/size/viewport_height", 648)),
		"selected_nodes": [],
		"ui_nodes": [],
	}
	if editor_interface == null:
		return context
	var root: Node = editor_interface.get_edited_scene_root()
	if root == null or not is_instance_valid(root):
		return context
	context["scene_id"] = "scene_%s" % str(root.get_instance_id())
	context["scene_path"] = str(root.scene_file_path)
	context["scene_root"] = "%s (%s)" % [root.name, root.get_class()]
	var selected_ids: Dictionary = {}
	var selection: EditorSelection = editor_interface.get_selection()
	if selection != null:
		for selected_value: Variant in selection.get_selected_nodes():
			var selected_node: Node = selected_value as Node
			if selected_node != null and is_instance_valid(selected_node):
				selected_ids[selected_node.get_instance_id()] = true
				(context["selected_nodes"] as Array).append({
					"path": str(root.get_path_to(selected_node)),
					"type": selected_node.get_class(),
				})
	var queue: Array[Dictionary] = []
	queue.append({"node": root, "depth": 0})
	var cursor: int = 0
	while cursor < queue.size() and (context["ui_nodes"] as Array).size() < 64:
		var entry: Dictionary = queue[cursor]
		cursor += 1
		var node: Node = entry.get("node") as Node
		var depth: int = int(entry.get("depth", 0))
		if node == null or not is_instance_valid(node):
			continue
		if node is Control:
			var control: Control = node as Control
			var descriptor: Dictionary = {
				"path": str(root.get_path_to(control)),
				"name": str(control.name),
				"type": control.get_class(),
				"size": [roundi(control.size.x), roundi(control.size.y)],
				"position": [roundi(control.position.x), roundi(control.position.y)],
				"visible": control.visible,
				"selected": selected_ids.has(control.get_instance_id()),
			}
			if control is Label:
				descriptor["text_hint"] = (control as Label).text.left(160)
			elif control is Button:
				descriptor["text_hint"] = (control as Button).text.left(160)
			var theme: Theme = control.theme
			if theme != null and not theme.resource_path.is_empty():
				descriptor["theme"] = theme.resource_path
			(context["ui_nodes"] as Array).append(descriptor)
		if depth >= 8:
			continue
		for child_value: Variant in node.get_children():
			var child: Node = child_value as Node
			if child != null and is_instance_valid(child):
				queue.append({"node": child, "depth": depth + 1})
	return context


func open_connection_settings() -> void:
	_open_settings()


func shutdown() -> void:
	if _shutting_down:
		return
	_shutting_down = true
	set_process(false)
	_close_annotation_editor()
	_cancel_deferred_editor_tool_requests("GodotX was disabled before the editor operation completed")
	_pending_editor_tool_responses.clear()
	_clear_editor_scene_write_grants()
	var owns_runtime := _runtime_pid > 0 and OS.is_process_running(_runtime_pid)
	if owns_runtime and _socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_send_request("shutdown", {}, true)
	if _socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_socket.close(1000, "Plugin disabled")
	if owns_runtime:
		OS.kill(_runtime_pid)
	_runtime_pid = -1
	_clear_turn_scene_leases()
	_pending_attachments.clear()
	_pending_visual_imports = 0
	_queued_attachments.clear()
	_queued_turn_active = false
	_image_generation_requests.clear()
	_image_context_captures.clear()
	_visual_capture = null
	_attachment_store = null
	_editor_bridge = null


static func _runtime_connection_warning_due(
	connected: bool,
	reported: bool,
	started_at_ms: int,
	now_ms: int
) -> bool:
	return (
		not connected
		and not reported
		and started_at_ms > 0
		and now_ms - started_at_ms >= RUNTIME_CONNECT_WARNING_MS
	)


func _process(_delta: float) -> void:
	if _shutting_down:
		return
	_socket.poll()
	var state := _socket.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN:
		if not _connected:
			_connected = true
			_runtime_start_requested_at_ms = 0
			_runtime_start_warning_reported = false
			_set_status("Authorizing runtime", Color("d5a15d"))
		while _socket.get_available_packet_count() > 0:
			var text := _socket.get_packet().get_string_from_utf8()
			_handle_packet(text)
	elif state == WebSocketPeer.STATE_CLOSED:
		if _connected:
			_finish_activity_indicator("Stopped")
			_connected = false
			_server_ready = false
			_configured_fingerprint = ""
			_configure_fingerprint_pending = ""
			_configure_purpose = ""
			_providers_ready = false
			_provider_sync_in_flight = false
			_sessions_ready = false
			_sessions_ready_before_sync = false
			_session_sync_in_flight = false
			_session_create_purpose = ""
			_session_get_target_id = ""
			_session_get_refresh_only = false
			_session_snapshot.clear()
			_session_history_page = 0
			_session_diagnostic_fingerprint = ""
			_pending_session_diagnostics.clear()
			_turn_in_progress = false
			_model_sync_in_flight = false
			_models_ready = false
			_models_ready_before_sync = false
			_queued_prompt = ""
			_queued_turn_active = false
			_queued_model = ""
			_queued_reasoning = ""
			_queued_runtime_automation_enabled = false
			_queued_attachments.clear()
			_queued_editor_context.clear()
			_cancel_deferred_editor_tool_requests("The Runtime connection closed before the editor operation completed")
			_pending_editor_tool_responses.clear()
			_clear_turn_scene_leases()
			for generation_value: Variant in _image_generation_requests.values():
				image_generation_failed.emit(str(generation_value), _t("Connection lost during image generation"))
			_image_generation_requests.clear()
			for workflow_value: Variant in _image_context_captures.keys():
				image_generation_failed.emit(str(workflow_value), _t("Connection lost during image generation"))
			_image_context_captures.clear()
			_pending.clear()
			_clear_approval()
			_clear_editor_scene_write_grants()
			_reset_message_stream()
			_stop_button.disabled = true
			_update_controls()
			_set_status("Disconnected", Color("d5a15d"))
			_append_system("Connection lost. Reconnecting to the saved conversation.")
		if Time.get_ticks_msec() >= _reconnect_at:
			_reconnect_at = Time.get_ticks_msec() + 1000
			if _runtime_pid <= 0 or not OS.is_process_running(_runtime_pid):
				_start_runtime()
			_socket = WebSocketPeer.new()
			_configure_socket(_socket)
			_socket.connect_to_url("ws://127.0.0.1:%d/?token=%s" % [_runtime_port, _auth_token])
	if state != WebSocketPeer.STATE_OPEN and _runtime_connection_warning_due(
		_connected,
		_runtime_start_warning_reported,
		_runtime_start_requested_at_ms,
		Time.get_ticks_msec()
	):
		_runtime_start_warning_reported = true
		_set_status("Runtime connection failed", Color("d87979"))
		_append_system(
			"GodotX Runtime did not connect. Check the Godot Output panel, then reload the plugin."
		)
	if (not _delta_buffer.is_empty() or not _reasoning_delta_buffer.is_empty()) and Time.get_ticks_msec() >= _next_delta_flush:
		_flush_deltas()
	_update_activity_indicator()
	_settle_conversation_scroll_input()
	_settle_conversation_scroll()


func _build_ui() -> void:
	_ensure_visual_services()
	_ensure_builtin_provider_descriptor()
	custom_minimum_size = Vector2(360, 0)
	add_theme_constant_override("separation", 10)

	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 4)
	var brand_mark := TextureRect.new()
	brand_mark.texture = GODETX_MARK
	brand_mark.custom_minimum_size = Vector2(24, 24)
	brand_mark.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	brand_mark.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	brand_mark.mouse_filter = Control.MOUSE_FILTER_IGNORE
	header.add_child(brand_mark)
	var brand := Label.new()
	brand.text = "GodotX"
	brand.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	brand.add_theme_font_size_override("font_size", 16)
	header.add_child(brand)
	_status_dot = PanelContainer.new()
	_status_dot.add_theme_stylebox_override("panel", _status_indicator_style(Color("d5a15d")))
	_status_dot.custom_minimum_size = Vector2(7, 7)
	_status_dot.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	_status_dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_status_dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	header.add_child(_status_dot)
	_status = Label.new()
	_status.text = _t("Starting runtime")
	_status.clip_text = true
	_status.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_status.custom_minimum_size.x = 82
	_status.tooltip_text = _status.text
	header.add_child(_status)
	_refresh_models_button = _icon_button("Reload", "Refresh models")
	_refresh_models_button.disabled = true
	_refresh_models_button.pressed.connect(_begin_model_sync)
	header.add_child(_refresh_models_button)
	_settings_button = _icon_button("Tools", "Connection settings")
	_settings_button.pressed.connect(_open_settings)
	header.add_child(_settings_button)
	add_child(header)

	var session_row := HBoxContainer.new()
	session_row.add_theme_constant_override("separation", 4)
	_session_select = OptionButton.new()
	_session_select.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_session_select.get_popup().auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_session_select.fit_to_longest_item = false
	_session_select.clip_text = true
	_session_select.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_session_select.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_session_select.tooltip_text = _t("Conversations")
	_session_select.item_selected.connect(_on_session_selected)
	session_row.add_child(_session_select)
	_clear_button = Button.new()
	_clear_button.flat = true
	_clear_button.text = "+"
	_clear_button.custom_minimum_size = Vector2(32, 32)
	_clear_button.tooltip_text = _t("New conversation")
	_clear_button.pressed.connect(_create_new_session)
	session_row.add_child(_clear_button)
	_session_menu = MenuButton.new()
	_session_menu.flat = true
	_session_menu.text = "..."
	_session_menu.custom_minimum_size = Vector2(32, 32)
	_session_menu.tooltip_text = _t("Conversation actions")
	_session_menu.get_popup().add_item(_t("Rename conversation"), SESSION_MENU_RENAME)
	_session_menu.get_popup().add_item(_t("Delete conversation"), SESSION_MENU_DELETE)
	_session_menu.get_popup().id_pressed.connect(_on_session_menu_pressed)
	session_row.add_child(_session_menu)
	add_child(session_row)

	var separator := HSeparator.new()
	add_child(separator)

	_conversation_scroll = ScrollContainer.new()
	_conversation_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_conversation_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	_conversation_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_conversation_scroll.size_flags_stretch_ratio = 1.0
	_conversation_scroll.custom_minimum_size.y = 0
	_conversation = VBoxContainer.new()
	_conversation.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_conversation.add_theme_constant_override("separation", 14)
	_conversation.minimum_size_changed.connect(_on_conversation_layout_changed)
	_conversation_scroll.add_child(_conversation)
	_conversation_scroll.gui_input.connect(_on_conversation_scroll_input.bind(false))
	_conversation_scroll.get_v_scroll_bar().gui_input.connect(_on_conversation_scroll_input.bind(true))
	_conversation_scroll.scroll_started.connect(_on_conversation_touch_scroll_started)
	_conversation_scroll.scroll_ended.connect(_on_conversation_touch_scroll_ended)
	_conversation_scroll.resized.connect(_on_conversation_layout_changed)
	resized.connect(_on_conversation_layout_changed)
	add_child(_conversation_scroll)

	_composer_drop_target = ResourceDropTarget.new()
	_composer_drop_target.accepted_extensions = PackedStringArray(
		PROJECT_VISUAL_RESOURCE_EXTENSIONS
	)
	_composer_drop_target.allow_multiple = true
	_composer_drop_target.can_accept_paths = Callable(self, "_can_drop_project_visual_paths")
	_composer_drop_target.resource_paths_dropped.connect(_on_attachment_project_files_selected)
	_composer = _composer_drop_target as PanelContainer
	_composer.size_flags_vertical = Control.SIZE_SHRINK_END
	_composer.add_theme_stylebox_override(
		"panel",
		_panel_style(
			_editor_color("dark_color_1", Color("25272b")),
			_editor_color("dark_color_3", Color("484b52")),
			8,
			10
		)
	)
	var composer_content := VBoxContainer.new()
	composer_content.add_theme_constant_override("separation", 6)
	_composer.add_child(composer_content)

	_prompt = TextEdit.new()
	_prompt.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_prompt.placeholder_text = _t("Ask GodotX to inspect or change this project")
	_prompt.tooltip_text = _t("Drop project resources here")
	_prompt.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_prompt.custom_minimum_size.y = 76
	_prompt.add_theme_stylebox_override("normal", StyleBoxEmpty.new())
	_prompt.add_theme_stylebox_override("focus", StyleBoxEmpty.new())
	_prompt.add_theme_stylebox_override("read_only", StyleBoxEmpty.new())
	_prompt.gui_input.connect(_on_prompt_gui_input)
	_prompt.text_changed.connect(_update_controls)
	composer_content.add_child(_prompt)

	var attachment_row := HBoxContainer.new()
	attachment_row.add_theme_constant_override("separation", 6)
	_attachment_menu = MenuButton.new()
	_attachment_menu.flat = true
	_attachment_menu.icon = _icon_texture("File")
	_attachment_menu.custom_minimum_size = Vector2(32, 32)
	_attachment_menu.tooltip_text = _t("Add visual attachment")
	_attachment_menu.get_popup().add_item(_t("Add image from file"), ATTACHMENT_MENU_FILE)
	_attachment_menu.get_popup().add_item(
		_t("Add project resource preview"),
		ATTACHMENT_MENU_PROJECT_RESOURCE
	)
	_attachment_menu.get_popup().add_separator()
	_attachment_menu.get_popup().add_item(
		_t("Capture 2D editor viewport"),
		ATTACHMENT_MENU_VIEWPORT_2D
	)
	_attachment_menu.get_popup().add_item(
		_t("Capture 3D editor viewport"),
		ATTACHMENT_MENU_VIEWPORT_3D
	)
	_attachment_menu.get_popup().id_pressed.connect(_on_attachment_menu_pressed)
	attachment_row.add_child(_attachment_menu)
	_attachment_scroll = ScrollContainer.new()
	_attachment_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	_attachment_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_attachment_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_attachment_scroll.custom_minimum_size.y = 52
	_attachment_scroll.visible = false
	_attachment_list = HBoxContainer.new()
	_attachment_list.add_theme_constant_override("separation", 8)
	_attachment_scroll.add_child(_attachment_list)
	attachment_row.add_child(_attachment_scroll)
	composer_content.add_child(attachment_row)

	var composer_toolbar := HBoxContainer.new()
	composer_toolbar.add_theme_constant_override("separation", 6)
	_model_select = OptionButton.new()
	_model_select.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_model_select.get_popup().auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_model_select.fit_to_longest_item = false
	_model_select.clip_text = true
	_model_select.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_model_select.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_model_select.custom_minimum_size.x = 90
	_model_select.tooltip_text = _t("Model")
	_model_select.add_item(DEFAULT_MODEL)
	_model_select.set_item_metadata(0, DEFAULT_MODEL)
	_model_select.disabled = true
	_model_select.item_selected.connect(_on_model_selected)
	composer_toolbar.add_child(_model_select)
	_reasoning_select = OptionButton.new()
	_reasoning_select.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_reasoning_select.get_popup().auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_reasoning_select.fit_to_longest_item = false
	_reasoning_select.custom_minimum_size.x = 64
	_reasoning_select.tooltip_text = _t("Reasoning effort")
	_reasoning_select.item_selected.connect(_on_reasoning_selected)
	_rebuild_reasoning_options(_selected_model())
	composer_toolbar.add_child(_reasoning_select)
	_approval_mode_select = OptionButton.new()
	_approval_mode_select.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_approval_mode_select.get_popup().auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_approval_mode_select.fit_to_longest_item = false
	_approval_mode_select.clip_text = true
	_approval_mode_select.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_approval_mode_select.custom_minimum_size.x = 130
	_approval_mode_select.add_item(_t(APPROVAL_LABEL_ASK))
	_approval_mode_select.set_item_metadata(0, APPROVAL_MODE_ASK)
	_approval_mode_select.get_popup().set_item_tooltip(
		0,
		_t("Ask before applying edits, running commands, or starting the game.")
	)
	_approval_mode_select.add_item(_t(APPROVAL_LABEL_AUTO_EDITS))
	_approval_mode_select.set_item_metadata(1, APPROVAL_MODE_AUTO_EDITS)
	_approval_mode_select.get_popup().set_item_tooltip(
		1,
		_t("Automatically approve edits, commands, and game starts.")
	)
	_sync_approval_controls()
	_approval_mode_select.item_selected.connect(_on_approval_mode_selected)
	composer_toolbar.add_child(_approval_mode_select)
	_stop_button = _icon_button("Stop", "Stop current task")
	_stop_button.disabled = true
	_stop_button.visible = false
	_stop_button.pressed.connect(_stop_turn)
	composer_toolbar.add_child(_stop_button)
	_send_button = _icon_button("Play", "Send message (Enter)")
	_send_button.flat = false
	_send_button.disabled = true
	_send_button.pressed.connect(_submit)
	composer_toolbar.add_child(_send_button)
	composer_content.add_child(composer_toolbar)
	_forward_composer_resource_drop_tree(composer_content)
	add_child(_composer)

	_settings_dialog = ConfirmationDialog.new()
	_settings_dialog.title = _t("GodotX settings")
	_settings_dialog.ok_button_text = _t("Apply")
	var settings_content := VBoxContainer.new()
	settings_content.custom_minimum_size = Vector2(500, 0)
	settings_content.add_theme_constant_override("separation", 8)
	var provider_grid := GridContainer.new()
	provider_grid.columns = 2
	provider_grid.add_child(_label("Provider"))
	_settings_provider_select = OptionButton.new()
	_settings_provider_select.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_settings_provider_select.get_popup().auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_settings_provider_select.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_settings_provider_select.item_selected.connect(_on_settings_provider_selected)
	provider_grid.add_child(_settings_provider_select)
	settings_content.add_child(provider_grid)
	_settings_legacy_fields = GridContainer.new()
	_settings_legacy_fields.columns = 2
	_settings_legacy_fields.add_child(_label("Base URL"))
	_settings_base_url = LineEdit.new()
	_settings_base_url.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_settings_base_url.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_settings_legacy_fields.add_child(_settings_base_url)
	_settings_legacy_fields.add_child(_label("API key"))
	_settings_api_key = LineEdit.new()
	_settings_api_key.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_settings_api_key.secret = true
	_settings_api_key.placeholder_text = _t("Enter API key")
	_settings_legacy_fields.add_child(_settings_api_key)
	settings_content.add_child(_settings_legacy_fields)
	_settings_dynamic_fields = GridContainer.new()
	_settings_dynamic_fields.columns = 2
	settings_content.add_child(_settings_dynamic_fields)
	var preferences_grid := GridContainer.new()
	preferences_grid.columns = 2
	preferences_grid.add_child(_label("Storage"))
	_remember_api_key = CheckButton.new()
	_remember_api_key.text = _t("Remember secrets")
	_remember_api_key.button_pressed = _remember_api_key_enabled
	_remember_api_key.tooltip_text = _t("Store provider secrets as plaintext in Godot's user-level EditorSettings, scoped to this project path. Disable and Apply to remove them.")
	preferences_grid.add_child(_remember_api_key)
	preferences_grid.add_child(_label("Approvals"))
	_auto_approve_edits = CheckButton.new()
	_auto_approve_edits.text = _t("Auto-approve all actions")
	_auto_approve_edits.button_pressed = _auto_approve_edits_enabled
	_auto_approve_edits.tooltip_text = _t("Automatically approve all allowed edits, commands, and game starts.")
	preferences_grid.add_child(_auto_approve_edits)
	preferences_grid.add_child(_label("Game testing"))
	_runtime_automation = CheckButton.new()
	_runtime_automation.text = _t("Use runtime automation")
	_runtime_automation.button_pressed = _runtime_automation_enabled
	_runtime_automation.tooltip_text = _t("Run bounded simulated input and assertions inside GodotX-started games without modifying project scripts.")
	preferences_grid.add_child(_runtime_automation)
	settings_content.add_child(preferences_grid)
	_settings_dialog.add_child(settings_content)
	_settings_dialog.confirmed.connect(_apply_settings)
	add_child(_settings_dialog)

	_attachment_file_dialog = FileDialog.new()
	_attachment_file_dialog.title = _t("Add images")
	_attachment_file_dialog.access = FileDialog.ACCESS_FILESYSTEM
	_attachment_file_dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILES
	_attachment_file_dialog.add_filter(
		"*.png, *.jpg, *.jpeg, *.webp, *.bmp, *.tga",
		_t("Image files")
	)
	_attachment_file_dialog.files_selected.connect(_on_attachment_files_selected)
	add_child(_attachment_file_dialog)

	_attachment_project_dialog = EditorFileDialog.new()
	_attachment_project_dialog.title = _t("Add project resource preview")
	_attachment_project_dialog.access = FileDialog.ACCESS_RESOURCES
	_attachment_project_dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILES
	_attachment_project_dialog.add_filter(
		"*.png, *.jpg, *.jpeg, *.webp, *.bmp, *.tga, *.svg",
		_t("Project images")
	)
	_attachment_project_dialog.add_filter(
		"*.tres, *.res, *.material, *.mesh, *.tscn, *.scn",
		_t("Previewable resources")
	)
	_attachment_project_dialog.files_selected.connect(_on_attachment_project_files_selected)
	add_child(_attachment_project_dialog)
	_build_annotation_dialog()
	_populate_provider_options(_provider_id)
	_settings_provider_id = _provider_id
	_settings_provider_drafts = _provider_configs.duplicate(true)
	_settings_remember_drafts = _provider_remember_secrets.duplicate(true)
	_rebuild_settings_provider_fields(_settings_provider_id, _provider_config(_settings_provider_id))

	_approval_dialog = ConfirmationDialog.new()
	_approval_dialog.title = _t("GodotX approval")
	_approval_dialog.ok_button_text = _t("Approve")
	_approval_dialog.cancel_button_text = _t("Decline")
	_approval_diff = TextEdit.new()
	_approval_diff.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_approval_diff.editable = false
	_approval_diff.wrap_mode = TextEdit.LINE_WRAPPING_NONE
	_approval_diff.custom_minimum_size = Vector2(760, 460)
	_approval_dialog.add_child(_approval_diff)
	_approval_dialog.confirmed.connect(_resolve_approval.bind("accept"))
	_approval_dialog.canceled.connect(_resolve_approval.bind("decline"))
	add_child(_approval_dialog)

	_rename_session_dialog = ConfirmationDialog.new()
	_rename_session_dialog.title = _t("Rename conversation")
	_rename_session_dialog.ok_button_text = _t("Rename")
	_rename_session_input = LineEdit.new()
	_rename_session_input.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_rename_session_input.max_length = 120
	_rename_session_input.custom_minimum_size = Vector2(360, 36)
	_rename_session_dialog.add_child(_rename_session_input)
	_rename_session_dialog.confirmed.connect(_confirm_rename_session)
	add_child(_rename_session_dialog)

	_delete_session_dialog = ConfirmationDialog.new()
	_delete_session_dialog.title = _t("Delete conversation")
	_delete_session_dialog.dialog_text = _t("Delete this conversation and its saved history? This cannot be undone.")
	_delete_session_dialog.ok_button_text = _t("Delete")
	_delete_session_dialog.confirmed.connect(_confirm_delete_session)
	add_child(_delete_session_dialog)
	_update_controls()


func _build_annotation_dialog() -> void:
	_annotation_dialog = Window.new()
	_annotation_dialog.title = _t("Image annotations")
	_annotation_dialog.min_size = Vector2i(640, 480)
	_annotation_dialog.max_size = Vector2i(1200, 900)
	_annotation_dialog.size = Vector2i(900, 680)
	_annotation_dialog.visible = false
	_annotation_dialog.transient = true
	_annotation_dialog.exclusive = true
	_annotation_dialog.close_requested.connect(_close_annotation_editor)
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", 12)
	margin.add_theme_constant_override("margin_top", 12)
	margin.add_theme_constant_override("margin_right", 12)
	margin.add_theme_constant_override("margin_bottom", 12)
	var content := VBoxContainer.new()
	content.add_theme_constant_override("separation", 8)
	margin.add_child(content)
	var toolbar := HBoxContainer.new()
	toolbar.add_theme_constant_override("separation", 4)
	_annotation_tool_group = ButtonGroup.new()
	_annotation_tool_group.allow_unpress = false
	_annotation_tool_buttons.clear()
	for specification in [
		[_t("Arrow"), ImageAnnotationEditor.ToolMode.ARROW],
		[_t("Rectangle"), ImageAnnotationEditor.ToolMode.RECTANGLE],
		[_t("Circle"), ImageAnnotationEditor.ToolMode.CIRCLE],
	]:
		var mode_button := Button.new()
		mode_button.text = str(specification[0])
		mode_button.toggle_mode = true
		mode_button.button_group = _annotation_tool_group
		mode_button.set_meta("annotation_mode", int(specification[1]))
		mode_button.pressed.connect(_on_annotation_tool_pressed.bind(int(specification[1])))
		toolbar.add_child(mode_button)
		_annotation_tool_buttons.append(mode_button)
	_annotation_tool_buttons[0].button_pressed = true
	var toolbar_spacer := Control.new()
	toolbar_spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	toolbar.add_child(toolbar_spacer)
	_annotation_undo_button = _theme_icon_button(&"Undo", "Undo annotation")
	_annotation_undo_button.pressed.connect(_undo_annotation)
	toolbar.add_child(_annotation_undo_button)
	_annotation_clear_button = _icon_button("Clear", "Clear annotations")
	_annotation_clear_button.pressed.connect(_clear_annotations)
	toolbar.add_child(_annotation_clear_button)
	content.add_child(toolbar)
	_annotation_editor = ImageAnnotationEditor.new()
	_annotation_editor.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_annotation_editor.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_annotation_editor.custom_minimum_size = Vector2(600, 380)
	_annotation_editor.annotations_changed.connect(_on_annotations_changed)
	content.add_child(_annotation_editor)
	var actions := HBoxContainer.new()
	var action_spacer := Control.new()
	action_spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	actions.add_child(action_spacer)
	_annotation_cancel_button = Button.new()
	_annotation_cancel_button.text = _t("Cancel")
	_annotation_cancel_button.pressed.connect(_close_annotation_editor)
	actions.add_child(_annotation_cancel_button)
	_annotation_save_button = Button.new()
	_annotation_save_button.text = _t("Save annotation")
	_annotation_save_button.pressed.connect(_save_annotation)
	actions.add_child(_annotation_save_button)
	content.add_child(actions)
	_annotation_dialog.add_child(margin)
	add_child(_annotation_dialog)
	_on_annotations_changed([])


func _ensure_visual_services() -> void:
	if _attachment_store == null:
		_attachment_store = AttachmentStore.new()
	if _visual_capture == null:
		_visual_capture = VisualCapture.new(editor_interface, _attachment_store)
	else:
		_visual_capture.configure(editor_interface, _attachment_store)


func _icon_button(icon_name: String, tooltip: String) -> Button:
	var button := Button.new()
	button.flat = true
	button.custom_minimum_size = Vector2(32, 32)
	button.tooltip_text = _t(tooltip)
	var icon := _icon_texture(icon_name)
	if icon:
		button.icon = icon
	else:
		button.text = _t(tooltip).left(1)
	return button


func _theme_icon_button(theme_icon: StringName, tooltip: String) -> Button:
	var button := Button.new()
	button.flat = true
	button.custom_minimum_size = Vector2(32, 32)
	button.tooltip_text = _t(tooltip)
	if has_theme_icon(theme_icon, &"EditorIcons"):
		button.icon = get_theme_icon(theme_icon, &"EditorIcons")
	else:
		button.text = _t(tooltip)
	return button


func _icon_texture(icon_name: String) -> Texture2D:
	if ICONS.has(icon_name):
		return ICONS[icon_name] as Texture2D
	return null


func _panel_style(background: Color, border: Color, radius: int, padding: float) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = background
	style.border_color = border
	style.border_width_left = 1
	style.border_width_top = 1
	style.border_width_right = 1
	style.border_width_bottom = 1
	style.corner_radius_top_left = radius
	style.corner_radius_top_right = radius
	style.corner_radius_bottom_left = radius
	style.corner_radius_bottom_right = radius
	style.content_margin_left = padding
	style.content_margin_top = padding
	style.content_margin_right = padding
	style.content_margin_bottom = padding
	return style


func _status_indicator_style(color: Color) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = color
	style.corner_radius_top_left = 4
	style.corner_radius_top_right = 4
	style.corner_radius_bottom_left = 4
	style.corner_radius_bottom_right = 4
	return style


func _editor_color(color_name: StringName, fallback: Color) -> Color:
	if has_theme_color(color_name, "Editor"):
		return get_theme_color(color_name, "Editor")
	return fallback


static func _prompt_key_action(event: InputEvent, ime_active: bool = false) -> int:
	var key_event := event as InputEventKey
	if key_event == null or not key_event.pressed:
		return PROMPT_KEY_PASS
	if key_event.keycode != KEY_ENTER and key_event.keycode != KEY_KP_ENTER:
		return PROMPT_KEY_PASS
	if key_event.shift_pressed or ime_active:
		return PROMPT_KEY_PASS
	if key_event.echo:
		return PROMPT_KEY_CONSUME
	return PROMPT_KEY_SUBMIT


static func _is_image_paste_shortcut(event: InputEvent, ime_active: bool = false) -> bool:
	var key_event := event as InputEventKey
	if key_event == null or not key_event.pressed or key_event.echo or ime_active:
		return false
	if key_event.keycode != KEY_V and key_event.physical_keycode != KEY_V:
		return false
	return key_event.ctrl_pressed or key_event.meta_pressed


func _on_prompt_gui_input(event: InputEvent) -> void:
	if _is_image_paste_shortcut(event, _prompt.has_ime_text()) and DisplayServer.clipboard_has_image():
		var clipboard_image: Image = DisplayServer.clipboard_get_image()
		if clipboard_image != null and not clipboard_image.is_empty():
			_prompt.accept_event()
			_add_image_attachment(clipboard_image, "clipboard", _t("Pasted image"))
			return
	var action := _prompt_key_action(event, _prompt.has_ime_text())
	if action == PROMPT_KEY_PASS:
		return
	_prompt.accept_event()
	if action == PROMPT_KEY_SUBMIT:
		_submit()


func _forward_composer_resource_drop_tree(node: Node) -> void:
	if _composer_drop_target == null or node == null:
		return
	if node is Control:
		_composer_drop_target.forward_drop_from(node as Control)
	for child: Node in node.get_children():
		_forward_composer_resource_drop_tree(child)


func _visual_attachment_input_busy() -> bool:
	return (
		_shutting_down
		or _turn_in_progress
		or _model_sync_in_flight
		or _provider_sync_in_flight
		or _session_sync_in_flight
		or _plugin_reload_required
		or not _server_ready
		or not _models_ready
	)


func _can_drop_project_visual_paths(paths: PackedStringArray) -> bool:
	return (
		not paths.is_empty()
		and _pending_visual_imports == 0
		and not _visual_attachment_input_busy()
		and _can_add_visual_attachment(false)
	)


func _on_attachment_menu_pressed(menu_id: int) -> void:
	if not _can_add_visual_attachment(true):
		return
	match menu_id:
		ATTACHMENT_MENU_FILE:
			_attachment_file_dialog.popup_centered_ratio(0.72)
		ATTACHMENT_MENU_PROJECT_RESOURCE:
			_attachment_project_dialog.popup_centered_ratio(0.72)
		ATTACHMENT_MENU_VIEWPORT_2D:
			_queue_editor_viewport_attachment("2d")
		ATTACHMENT_MENU_VIEWPORT_3D:
			_queue_editor_viewport_attachment("3d")


func _on_attachment_files_selected(paths: PackedStringArray) -> void:
	for path in paths:
		if not _can_add_visual_attachment(true):
			break
		_on_visual_attachment_ready(_attachment_store.import_file(str(path), "file"))


func _on_attachment_project_files_selected(paths: PackedStringArray) -> void:
	if _pending_visual_imports > 0 or _visual_attachment_input_busy():
		return
	for path in paths:
		if not _can_add_visual_attachment(true):
			break
		_queue_project_visual_attachment(str(path))


func _queue_project_visual_attachment(path: String) -> void:
	_pending_visual_imports += 1
	_update_controls()
	_visual_capture.import_project_resource(
		path,
		Callable(self, "_on_async_visual_attachment_ready")
	)


func _queue_editor_viewport_attachment(kind: String) -> void:
	if _visual_attachment_input_busy() or not _can_add_visual_attachment(true):
		return
	_pending_visual_imports += 1
	_update_controls()
	_visual_capture.capture_editor_viewport(
		kind,
		0,
		Callable(self, "_on_async_visual_attachment_ready")
	)


func _on_async_visual_attachment_ready(result: Dictionary) -> void:
	_pending_visual_imports = maxi(0, _pending_visual_imports - 1)
	if _shutting_down:
		return
	_on_visual_attachment_ready(result)
	_update_controls()


func _add_image_attachment(image: Image, source: String, display_name: String) -> void:
	if not _can_add_visual_attachment(true):
		return
	_on_visual_attachment_ready(
		_attachment_store.import_image(image, source, display_name)
	)


func _on_visual_attachment_ready(result: Dictionary) -> void:
	if not bool(result.get("ok", false)):
		_append_system(_localized_visual_error(str(
			result.get("error", "Visual attachment could not be added")
		)))
		return
	var attachment_value: Variant = result.get("attachment")
	if not attachment_value is Dictionary:
		_append_system(_t("Visual attachment could not be added"))
		return
	var attachment: Dictionary = AttachmentStore.metadata_reference(attachment_value as Dictionary)
	var attachment_id := str(attachment.get("attachment_id", ""))
	if not AttachmentStore.is_safe_attachment_id(attachment_id):
		_append_system(_t("Visual attachment could not be added"))
		return
	for existing in _pending_attachments:
		if str(existing.get("attachment_id", "")) == attachment_id:
			return
	if _pending_attachments.size() >= AttachmentStore.MAX_ATTACHMENTS_PER_TURN:
		_append_system(_t("A message can include at most %d images.") % AttachmentStore.MAX_ATTACHMENTS_PER_TURN)
		return
	_pending_attachments.append(attachment)
	_rebuild_attachment_list()
	_update_controls()


func _can_add_visual_attachment(show_error: bool = false) -> bool:
	var queued_count := _pending_attachments.size() + _pending_visual_imports
	if queued_count >= AttachmentStore.MAX_ATTACHMENTS_PER_TURN:
		if show_error:
			_append_system(_t("A message can include at most %d images.") % AttachmentStore.MAX_ATTACHMENTS_PER_TURN)
		return false
	if _selected_model_image_capability() == IMAGE_CAPABILITY_UNSUPPORTED:
		if show_error:
			_append_system(_t("The selected model does not support image input."))
		return false
	return true


func _remove_attachment(attachment_id: String) -> void:
	for index in range(_pending_attachments.size() - 1, -1, -1):
		if str(_pending_attachments[index].get("attachment_id", "")) == attachment_id:
			_pending_attachments.remove_at(index)
	_rebuild_attachment_list()
	_update_controls()


func _clear_pending_attachments() -> void:
	_pending_attachments.clear()
	_rebuild_attachment_list()
	_update_controls()


func _rebuild_attachment_list() -> void:
	if _attachment_list == null or _attachment_scroll == null:
		return
	for child in _attachment_list.get_children():
		var was_inside_tree := child.is_inside_tree()
		if was_inside_tree:
			child.queue_free()
		else:
			child.call_deferred(&"free")
		_attachment_list.remove_child(child)
	for attachment in _pending_attachments:
		var chip := _attachment_chip(attachment, true)
		_attachment_list.add_child(chip)
		_forward_composer_resource_drop_tree(chip)
	_attachment_scroll.visible = not _pending_attachments.is_empty()


func _attachment_chip(attachment: Dictionary, removable: bool) -> Control:
	var chip := HBoxContainer.new()
	var attachment_id := str(attachment.get("attachment_id", ""))
	chip.set_meta("attachment_id", attachment_id)
	chip.add_theme_constant_override("separation", 5)
	var preview := _attachment_preview_button(attachment, Vector2(44, 44))
	preview.pressed.connect(_open_pending_annotation.bind(attachment_id))
	chip.set_meta("annotation_button", preview)
	chip.add_child(preview)
	var details := VBoxContainer.new()
	details.custom_minimum_size.x = 96
	var name_label := Label.new()
	name_label.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	name_label.text = _attachment_display_name(attachment)
	name_label.clip_text = true
	name_label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	name_label.tooltip_text = name_label.text
	details.add_child(name_label)
	var size_label := Label.new()
	size_label.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	size_label.text = "%d x %d" % [
		int(attachment.get("width", 0)),
		int(attachment.get("height", 0)),
	]
	size_label.add_theme_font_size_override("font_size", 11)
	size_label.add_theme_color_override(
		"font_color",
		_editor_color("disabled_font_color", Color("9297a1"))
	)
	details.add_child(size_label)
	chip.add_child(details)
	if removable:
		var remove_button := _icon_button("Remove", "Remove attachment")
		remove_button.pressed.connect(
			_remove_attachment.bind(str(attachment.get("attachment_id", ""))),
			CONNECT_DEFERRED
		)
		chip.add_child(remove_button)
	return chip


func _attachment_preview_button(attachment: Dictionary, minimum_size: Vector2) -> TextureButton:
	var preview := TextureButton.new()
	preview.texture_normal = _attachment_store.load_preview(attachment)
	preview.custom_minimum_size = minimum_size
	preview.ignore_texture_size = true
	preview.stretch_mode = TextureButton.STRETCH_KEEP_ASPECT_CENTERED
	preview.focus_mode = Control.FOCUS_ALL
	preview.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	preview.tooltip_text = _t("Annotate image")
	return preview


func _attachment_display_name(attachment: Dictionary) -> String:
	var display_name := str(attachment.get("name", "")).strip_edges()
	if not display_name.is_empty():
		return display_name
	var source := str(attachment.get("source", "image")).replace("_", " ")
	return source.capitalize()


func _open_pending_annotation(attachment_id: String) -> void:
	for attachment in _pending_attachments:
		if str(attachment.get("attachment_id", "")) == attachment_id:
			_open_annotation_editor(attachment, true)
			return
	_append_system(_t("Attachment is no longer pending."))


func _open_annotation_copy(attachment: Dictionary) -> void:
	_open_annotation_editor(attachment, false)


func _open_annotation_editor(attachment: Dictionary, replace_pending: bool) -> void:
	if (
		_shutting_down
		or _turn_in_progress
		or _model_sync_in_flight
		or _provider_sync_in_flight
		or _session_sync_in_flight
		or not _image_generation_requests.is_empty()
		or not _image_context_captures.is_empty()
	):
		return
	if not replace_pending and not _can_add_visual_attachment(true):
		return
	var attachment_id := str(attachment.get("attachment_id", ""))
	if not AttachmentStore.is_safe_attachment_id(attachment_id):
		_append_system(_t("Annotation could not be saved"))
		return
	var base_id := str(attachment.get("annotated_from", attachment_id))
	if not AttachmentStore.is_safe_attachment_id(base_id):
		base_id = attachment_id
	var base_reference := attachment.duplicate(true)
	base_reference["attachment_id"] = base_id
	var image: Image = _attachment_store.load_image(base_reference)
	if image == null or not _annotation_editor.set_image(image, true):
		_append_system(_t("Annotation could not be saved"))
		return
	var existing_annotations: Array = AttachmentStore.normalize_annotations(
		attachment.get("annotations", [])
	)
	_annotation_editor.set_annotations(existing_annotations)
	_annotation_editor.set_tool_mode(ImageAnnotationEditor.ToolMode.ARROW)
	for button in _annotation_tool_buttons:
		button.button_pressed = int(button.get_meta("annotation_mode", -1)) == ImageAnnotationEditor.ToolMode.ARROW
	_annotation_edit_token += 1
	_annotation_target = {
		"token": _annotation_edit_token,
		"replace_pending": replace_pending,
		"attachment_id": attachment_id,
		"base_id": base_id,
		"attachment": attachment.duplicate(true),
	}
	_annotation_saving = false
	_on_annotations_changed(existing_annotations)
	_annotation_dialog.popup_centered(Vector2i(900, 680))


func _on_annotation_tool_pressed(mode: int) -> void:
	if _annotation_editor != null:
		_annotation_editor.set_tool_mode(mode)


func _undo_annotation() -> void:
	if _annotation_editor != null and not _annotation_saving:
		_annotation_editor.undo()


func _clear_annotations() -> void:
	if _annotation_editor != null and not _annotation_saving:
		_annotation_editor.clear_annotations()


func _on_annotations_changed(_annotations: Array) -> void:
	if _annotation_editor == null:
		return
	if _annotation_undo_button != null:
		_annotation_undo_button.disabled = _annotation_saving or not _annotation_editor.can_undo()
	if _annotation_clear_button != null:
		_annotation_clear_button.disabled = _annotation_saving or _annotation_editor.get_annotations().is_empty()
	if _annotation_save_button != null:
		_annotation_save_button.disabled = _annotation_saving or not _annotation_editor.has_image()
	if _annotation_cancel_button != null:
		_annotation_cancel_button.disabled = _annotation_saving
	for button in _annotation_tool_buttons:
		button.disabled = _annotation_saving


func _save_annotation() -> void:
	if _annotation_saving or _annotation_target.is_empty() or _annotation_editor == null:
		return
	var token := int(_annotation_target.get("token", 0))
	if token != _annotation_edit_token:
		return
	_annotation_saving = true
	_on_annotations_changed(_annotation_editor.get_annotations())
	var annotated_image: Image = _annotation_editor.get_annotated_image()
	var annotations: Array = AttachmentStore.normalize_annotations(_annotation_editor.get_annotations())
	if annotated_image == null:
		_annotation_save_failed("")
		return
	var attachment_value: Variant = _annotation_target.get("attachment")
	if not attachment_value is Dictionary:
		_annotation_save_failed("")
		return
	var original: Dictionary = attachment_value
	var base_id := str(_annotation_target.get("base_id", ""))
	var extra := _annotation_extra_metadata(original, annotations, base_id)
	var result: Dictionary = _attachment_store.import_image(
		annotated_image,
		str(original.get("source", "file")),
		_annotated_attachment_name(original),
		str(original.get("detail", AttachmentStore.DEFAULT_DETAIL)),
		extra
	)
	if token != _annotation_edit_token:
		return
	if not bool(result.get("ok", false)):
		_annotation_save_failed(str(result.get("error", "")))
		return
	if bool(_annotation_target.get("replace_pending", false)):
		if not _replace_pending_attachment(str(_annotation_target.get("attachment_id", "")), result):
			_annotation_save_failed(_t("Attachment is no longer pending."))
			return
	else:
		_on_visual_attachment_ready(result)
	_close_annotation_editor()


func _annotation_extra_metadata(
	attachment: Dictionary,
	annotations: Array,
	base_id: String
) -> Dictionary:
	var extra := {}
	for key in [
		"run_id",
		"scene_id",
		"scene_path",
		"captured_at_ms",
		"viewport_width",
		"viewport_height",
		"frame",
	]:
		if attachment.has(key):
			extra[key] = attachment[key]
	if not annotations.is_empty():
		extra["annotations"] = annotations.duplicate(true)
		extra["annotated_from"] = base_id
	return extra


func _annotated_attachment_name(attachment: Dictionary) -> String:
	var current_name := str(attachment.get("name", "image.png")).get_file()
	if current_name.is_empty():
		current_name = "image.png"
	var base_name := current_name.get_basename()
	if base_name.ends_with("-annotated"):
		base_name = base_name.trim_suffix("-annotated")
	return "%s-annotated.png" % base_name


func _replace_pending_attachment(attachment_id: String, result: Dictionary) -> bool:
	if not bool(result.get("ok", false)):
		return false
	var attachment_value: Variant = result.get("attachment")
	if not attachment_value is Dictionary:
		return false
	var replacement := AttachmentStore.metadata_reference(attachment_value as Dictionary)
	var replacement_id := str(replacement.get("attachment_id", ""))
	if not AttachmentStore.is_safe_attachment_id(replacement_id):
		return false
	var target_index := -1
	for index in range(_pending_attachments.size()):
		if str(_pending_attachments[index].get("attachment_id", "")) == attachment_id:
			target_index = index
			break
	if target_index < 0:
		return false
	for index in range(_pending_attachments.size()):
		if index != target_index and str(_pending_attachments[index].get("attachment_id", "")) == replacement_id:
			_pending_attachments.remove_at(target_index)
			_rebuild_attachment_list()
			_update_controls()
			return true
	_pending_attachments[target_index] = replacement
	_rebuild_attachment_list()
	_update_controls()
	return true


func _annotation_save_failed(detail: String) -> void:
	var message := _t("Annotation could not be saved")
	if not detail.strip_edges().is_empty():
		message = "%s: %s" % [message, _localized_visual_error(detail)]
	_append_system(message)
	_annotation_saving = false
	_on_annotations_changed(_annotation_editor.get_annotations())


func _close_annotation_editor() -> void:
	_annotation_edit_token += 1
	_annotation_target.clear()
	_annotation_saving = false
	if _annotation_editor != null:
		_annotation_editor.clear_image()
	if _annotation_dialog != null and _annotation_dialog.visible:
		_annotation_dialog.hide()


func _localized_visual_error(message: String) -> String:
	for prefix in [
		"Project resource does not exist: ",
		"Project resource could not be loaded: ",
		"The editor could not generate a preview for ",
	]:
		if message.begins_with(prefix):
			return _t(prefix + "%s") % message.trim_prefix(prefix)
	return _t(message)


func _attachment_protocol_refs(values: Array[Dictionary]) -> Array:
	var result: Array = []
	for value in values:
		var reference := AttachmentStore.protocol_reference(value)
		if AttachmentStore.is_safe_attachment_id(str(reference.get("attachment_id", ""))):
			result.append(reference)
	return result


func _message_label(muted: bool = false) -> RichTextLabel:
	var label := RichTextLabel.new()
	label.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	label.bbcode_enabled = false
	label.fit_content = true
	label.scroll_active = false
	label.selection_enabled = true
	label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	label.custom_minimum_size.y = 22
	label.add_theme_constant_override("line_separation", 4)
	label.add_theme_stylebox_override("normal", StyleBoxEmpty.new())
	label.meta_clicked.connect(_on_message_meta_clicked)
	if muted:
		label.add_theme_color_override("default_color", _editor_color("disabled_font_color", Color("9297a1")))
	return label


func _on_message_meta_clicked(meta: Variant) -> void:
	var url := str(meta).strip_edges()
	if MarkdownRenderer.is_safe_link(url):
		OS.shell_open(url)


func _message_icon(icon_name: String) -> TextureRect:
	var icon := TextureRect.new()
	icon.custom_minimum_size = Vector2(16, 16)
	icon.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	icon.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	icon.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var texture := _icon_texture(icon_name)
	if texture:
		icon.texture = texture
	else:
		icon.visible = false
	return icon


func _begin_activity_indicator() -> void:
	if is_instance_valid(_activity_root) and not _activity_phase.is_empty():
		return
	var follow := _should_follow_conversation()
	_activity_root = VBoxContainer.new()
	_activity_root.set_meta("message_kind", "assistant_turn")
	_activity_root.add_theme_constant_override("separation", 9)
	_activity_row = HBoxContainer.new()
	_activity_row.set_meta("message_kind", "activity")
	_activity_row.add_theme_constant_override("separation", 6)
	_activity_icon = _message_icon("Progress1")
	_activity_row.add_child(_activity_icon)
	var role := Label.new()
	role.text = "GodotX"
	role.add_theme_font_size_override("font_size", 12)
	role.add_theme_color_override("font_color", _editor_color("accent_color", Color("72a7ff")))
	_activity_row.add_child(role)
	_activity_label = Label.new()
	_activity_label.add_theme_font_size_override("font_size", 12)
	_activity_label.add_theme_color_override("font_color", _editor_color("disabled_font_color", Color("9297a1")))
	_activity_row.add_child(_activity_label)
	_activity_usage_label = Label.new()
	_activity_usage_label.set_meta("message_kind", "usage")
	_activity_usage_label.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	_activity_usage_label.add_theme_font_size_override("font_size", 11)
	_activity_usage_label.add_theme_color_override("font_color", _editor_color("disabled_font_color", Color("9297a1")))
	_activity_usage_label.visible = false
	_activity_row.add_child(_activity_usage_label)
	_activity_root.add_child(_activity_row)
	_activity_timeline = VBoxContainer.new()
	_activity_timeline.set_meta("message_kind", "turn_timeline")
	_activity_timeline.add_theme_constant_override("separation", 9)
	_activity_root.add_child(_activity_timeline)
	_conversation.add_child(_activity_root)
	_active_turn_id = ""
	_activity_phase = "Thinking"
	_activity_started_at = Time.get_ticks_msec()
	_activity_animation_step = -1
	_update_activity_indicator(true)
	_queue_scroll_to_bottom(follow)


func _set_activity_phase(phase: String) -> void:
	if not is_instance_valid(_activity_label):
		_begin_activity_indicator()
	if not is_instance_valid(_activity_label):
		return
	if _activity_phase == "Stopping" and phase != "Stopping":
		return
	_activity_phase = phase
	_activity_animation_step = -1
	_update_activity_indicator(true)


func _update_activity_usage(data: Dictionary) -> void:
	if not is_instance_valid(_activity_usage_label):
		return
	var input_tokens := maxi(0, int(data.get("input_tokens", 0)))
	var output_tokens := maxi(0, int(data.get("output_tokens", 0)))
	var total_tokens := maxi(0, int(data.get("total_tokens", input_tokens + output_tokens)))
	var context_characters := maxi(0, int(data.get("context_characters", 0)))
	var history_characters := maxi(context_characters, int(data.get("history_characters", context_characters)))
	var dropped_messages := maxi(0, int(data.get("dropped_messages", 0)))
	var compacted_tool_messages := maxi(0, int(data.get("compacted_tool_messages", 0)))
	var compacted := bool(data.get("context_compacted", false))
	if total_tokens <= 0 and input_tokens <= 0 and output_tokens <= 0 and context_characters <= 0:
		_activity_usage_label.visible = false
		return
	var labels := PackedStringArray()
	if total_tokens > 0 or input_tokens > 0 or output_tokens > 0:
		labels.append(_t("%d tokens") % total_tokens)
	if context_characters > 0:
		labels.append(_t("Context %s") % _format_compact_count(context_characters))
	if compacted:
		labels.append(_t("Compacted"))
	_activity_usage_label.text = "  ".join(labels)
	var tooltip_lines := PackedStringArray()
	if input_tokens > 0 or output_tokens > 0:
		tooltip_lines.append(_t("Input %d / Output %d tokens") % [input_tokens, output_tokens])
	if context_characters > 0:
		tooltip_lines.append(
			_t("Context %d / History %d characters") % [context_characters, history_characters]
		)
	if dropped_messages > 0 or compacted_tool_messages > 0:
		tooltip_lines.append(
			_t("Dropped %d messages / compacted %d tool results")
			% [dropped_messages, compacted_tool_messages]
		)
	_activity_usage_label.tooltip_text = "\n".join(tooltip_lines)
	_activity_usage_label.visible = true


static func _format_compact_count(value: int) -> String:
	if value >= 1000000:
		return "%.1fM" % (float(value) / 1000000.0)
	if value >= 1000:
		return "%.1fK" % (float(value) / 1000.0)
	return str(value)


func _update_activity_indicator(force: bool = false) -> void:
	if _activity_phase.is_empty() or not is_instance_valid(_activity_label):
		return
	var step := int(Time.get_ticks_msec() / 350) % 3
	if not force and step == _activity_animation_step:
		return
	_activity_animation_step = step
	_activity_label.text = "%s%s" % [_t(_activity_phase), ".".repeat(step + 1)]
	var progress_icon := "Progress%d" % (step + 1)
	var progress_texture := _icon_texture(progress_icon)
	if is_instance_valid(_activity_icon) and progress_texture:
		_activity_icon.texture = progress_texture
		_activity_icon.visible = true


func _finish_activity_indicator(result: String, duration_ms: int = -1) -> void:
	if not is_instance_valid(_activity_label) or _activity_phase.is_empty():
		_discard_activity_indicator()
		return
	var elapsed_milliseconds := duration_ms if duration_ms >= 0 else Time.get_ticks_msec() - _activity_started_at
	var elapsed_seconds := maxi(1, int(ceil(elapsed_milliseconds / 1000.0)))
	_activity_label.text = (
		_t("Worked for %ds") % elapsed_seconds
		if result == "Worked"
		else _t("%s after %ds") % [_t(result), elapsed_seconds]
	)
	_activity_label.add_theme_color_override("font_color", _editor_color("disabled_font_color", Color("9297a1")))
	var status_icon := "StatusSuccess" if result == "Worked" else ("StatusError" if result == "Failed" else "Stop")
	var status_texture := _icon_texture(status_icon)
	if is_instance_valid(_activity_icon) and status_texture:
		_activity_icon.texture = status_texture
		_activity_icon.visible = true
	_discard_activity_indicator()


func _discard_activity_indicator() -> void:
	_activity_root = null
	_activity_row = null
	_activity_timeline = null
	_activity_icon = null
	_activity_label = null
	_activity_usage_label = null
	_active_turn_id = ""
	_activity_phase = ""
	_activity_started_at = 0
	_activity_animation_step = -1


func _bind_activity_turn(turn_id: String) -> void:
	if turn_id.is_empty() or not is_instance_valid(_activity_root):
		return
	_active_turn_id = turn_id
	_activity_root.set_meta("turn_id", turn_id)


func _turn_timeline_parent() -> VBoxContainer:
	if is_instance_valid(_activity_timeline):
		return _activity_timeline
	return _conversation


func _add_user_message(text: String, attachments: Array = []) -> void:
	var root := VBoxContainer.new()
	root.set_meta("message_kind", "user")
	root.add_theme_constant_override("separation", 5)
	var header := HBoxContainer.new()
	var header_spacer := Control.new()
	header_spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(header_spacer)
	var role := Label.new()
	role.text = _t("You")
	role.add_theme_font_size_override("font_size", 12)
	role.add_theme_color_override("font_color", _editor_color("font_color", Color("e6e7e9")))
	header.add_child(role)
	root.add_child(header)
	var bubble_margin := MarginContainer.new()
	bubble_margin.add_theme_constant_override("margin_left", 28)
	var panel := PanelContainer.new()
	panel.add_theme_stylebox_override(
		"panel",
		_panel_style(
			_editor_color("dark_color_2", Color("303238")),
			_editor_color("dark_color_3", Color("45484f")),
			6,
			10
		)
	)
	var content := VBoxContainer.new()
	content.add_theme_constant_override("separation", 8)
	if not text.is_empty():
		var body := _message_label()
		body.text = text
		content.add_child(body)
	if not attachments.is_empty():
		content.add_child(_message_attachment_gallery(attachments))
	panel.add_child(content)
	bubble_margin.add_child(panel)
	root.add_child(bubble_margin)
	_conversation.add_child(root)
	_queue_scroll_to_bottom(true)


func _message_attachment_gallery(values: Array) -> Control:
	var scroll := ScrollContainer.new()
	scroll.set_meta("message_kind", "attachments")
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.custom_minimum_size.y = 86
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	for value in values:
		if not value is Dictionary:
			continue
		var attachment: Dictionary = value
		var item := VBoxContainer.new()
		item.custom_minimum_size.x = 92
		var preview := _attachment_preview_button(attachment, Vector2(92, 62))
		preview.pressed.connect(_open_annotation_copy.bind(attachment.duplicate(true)))
		item.add_child(preview)
		var caption := Label.new()
		caption.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		caption.text = _attachment_display_name(attachment)
		caption.clip_text = true
		caption.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		caption.tooltip_text = "%s\n%d x %d" % [
			caption.text,
			int(attachment.get("width", 0)),
			int(attachment.get("height", 0)),
		]
		caption.add_theme_font_size_override("font_size", 11)
		item.add_child(caption)
		row.add_child(item)
	scroll.add_child(row)
	return scroll


func _ensure_assistant_message(item_id: String) -> Dictionary:
	var stable_item_id := item_id if not item_id.is_empty() else "message_unknown"
	if _message_views_by_item_id.has(stable_item_id):
		var existing: Dictionary = _message_views_by_item_id[stable_item_id]
		if is_instance_valid(existing.get("root")):
			return existing

	var follow := _should_follow_conversation()
	var root := VBoxContainer.new()
	root.set_meta("message_kind", "assistant_segment")
	root.set_meta("item_id", stable_item_id)
	root.add_theme_constant_override("separation", 4)
	var reasoning_host := VBoxContainer.new()
	reasoning_host.add_theme_constant_override("separation", 4)
	root.add_child(reasoning_host)
	var body := _message_label()
	body.visible = false
	root.add_child(body)
	_turn_timeline_parent().add_child(root)

	var view := {
		"root": root,
		"body": body,
		"body_text": "",
		"reasoning_host": reasoning_host,
		"reasoning_text": "",
	}
	_message_views_by_item_id[stable_item_id] = view
	_queue_scroll_to_bottom(follow)
	return view


func _ensure_reasoning_body(view: Dictionary) -> RichTextLabel:
	if view.has("reasoning_body") and is_instance_valid(view.get("reasoning_body")):
		return view.reasoning_body as RichTextLabel
	var host := view.reasoning_host as VBoxContainer
	var margin := MarginContainer.new()
	margin.add_theme_constant_override("margin_left", 22)
	var body := _message_label(true)
	body.visible = true
	body.add_theme_font_size_override("normal_font_size", 13)
	margin.add_child(body)
	host.add_child(margin)
	view["reasoning_container"] = margin
	view["reasoning_body"] = body
	return body


func _queue_assistant_delta(item_id: String, delta: String) -> void:
	if delta.is_empty():
		return
	if not _delta_item_id.is_empty() and _delta_item_id != item_id:
		_flush_deltas()
	_delta_item_id = item_id
	_ensure_assistant_message(item_id)
	_delta_buffer += delta
	_message_had_delta = true
	_message_items_with_deltas[item_id] = true
	if _next_delta_flush == 0:
		_next_delta_flush = Time.get_ticks_msec() + 33


func _queue_reasoning_delta(item_id: String, delta: String) -> void:
	if delta.is_empty():
		return
	if not _reasoning_item_id.is_empty() and _reasoning_item_id != item_id:
		_flush_deltas()
	_reasoning_item_id = item_id
	var view := _ensure_assistant_message(item_id)
	_ensure_reasoning_body(view)
	_reasoning_delta_buffer += delta
	if _next_delta_flush == 0:
		_next_delta_flush = Time.get_ticks_msec() + 33


func _append_assistant_text(item_id: String, text: String) -> void:
	if text.is_empty():
		return
	var follow := _should_follow_conversation()
	var view := _ensure_assistant_message(item_id)
	var body := view.body as RichTextLabel
	body.visible = true
	view["body_text"] = str(view.get("body_text", "")) + text
	_render_markdown_subset(body, str(view.body_text))
	_queue_scroll_to_bottom(follow)


func _append_reasoning_text(item_id: String, text: String) -> void:
	if text.is_empty():
		return
	var follow := _should_follow_conversation()
	var view := _ensure_assistant_message(item_id)
	var body := _ensure_reasoning_body(view)
	view["reasoning_text"] = str(view.get("reasoning_text", "")) + text
	_render_markdown_subset(body, str(view.reasoning_text))
	_queue_scroll_to_bottom(follow)


func _render_markdown_subset(body: RichTextLabel, source: String) -> void:
	MarkdownRenderer.render(body, source, {
		"heading": _editor_color("font_color", Color("e6e7e9")),
		"muted": _editor_color("disabled_font_color", Color("9297a1")),
		"link": _editor_color("accent_color", Color("72a7ff")),
		"code": _editor_color("font_color", Color("d6d9df")),
		"code_background": _editor_color("dark_color_2", Color("18191d")),
		"inline_code_background": _editor_color("dark_color_3", Color("2d3036")),
		"border": _editor_color("dark_color_3", Color("555860")),
		"table_header_background": _editor_color("dark_color_3", Color("34373d")),
		"table_odd_background": _editor_color("dark_color_2", Color("25272c")),
		"table_even_background": _editor_color("dark_color_1", Color("202227")),
		"table_rows_omitted": _t("%d table rows omitted."),
	})


func _begin_tool_message(item_id: String, data: Dictionary) -> void:
	var stable_item_id := item_id if not item_id.is_empty() else "tool_unknown"
	if _tool_views_by_item_id.has(stable_item_id):
		return
	var follow := _should_follow_conversation()
	var name := str(data.get("name", "tool"))
	var arguments_value = data.get("arguments", {})
	var arguments: Dictionary = arguments_value if arguments_value is Dictionary else {}
	var panel := PanelContainer.new()
	panel.set_meta("message_kind", "tool")
	panel.set_meta("item_id", stable_item_id)
	panel.add_theme_stylebox_override(
		"panel",
		_panel_style(
			_editor_color("dark_color_1", Color("26282d")),
			_editor_color("dark_color_3", Color("41444b")),
			6,
			8
		)
	)
	var content := VBoxContainer.new()
	content.add_theme_constant_override("separation", 5)
	panel.add_child(content)
	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 6)
	header.add_child(_message_icon(_tool_icon_name(name)))
	var toggle := Button.new()
	toggle.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	toggle.flat = true
	toggle.toggle_mode = true
	toggle.text = _tool_title(name, arguments)
	toggle.icon = _icon_texture("GuiTreeArrowRight")
	toggle.alignment = HORIZONTAL_ALIGNMENT_LEFT
	toggle.clip_text = true
	toggle.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	toggle.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	toggle.tooltip_text = _t("Show tool details")
	header.add_child(toggle)
	var status := Label.new()
	status.text = _t("Running")
	status.add_theme_color_override("font_color", _editor_color("disabled_font_color", Color("9297a1")))
	header.add_child(status)
	content.add_child(header)

	var details := VBoxContainer.new()
	details.visible = false
	details.add_theme_constant_override("separation", 7)
	details.add_child(HSeparator.new())
	var arguments_section := _tool_detail_section(details, "Arguments", TOOL_DETAIL_ARGUMENTS_MAX_HEIGHT)
	var output_section := _tool_detail_section(details, "Output", TOOL_DETAIL_MAX_HEIGHT)
	var changes_section := _tool_detail_section(details, "Changes", TOOL_DETAIL_ARGUMENTS_MAX_HEIGHT)
	var diff_section := _tool_detail_section(details, "Diff", TOOL_DETAIL_DIFF_MAX_HEIGHT)
	var arguments_body := arguments_section.body as RichTextLabel
	var body := output_section.body as RichTextLabel
	var changes_body := changes_section.body as RichTextLabel
	var diff_body := diff_section.body as RichTextLabel
	arguments_body.text = _limit_tool_detail(_format_tool_arguments_value(name, arguments_value))
	(arguments_section.root as Control).visible = not arguments_body.get_parsed_text().is_empty()
	(output_section.root as Control).visible = false
	(changes_section.root as Control).visible = false
	(diff_section.root as Control).visible = false
	toggle.toggled.connect(_on_tool_details_toggled.bind(details, toggle))
	content.add_child(details)
	_turn_timeline_parent().add_child(panel)
	_tool_views_by_item_id[stable_item_id] = {
		"root": panel,
		"toggle": toggle,
		"details": details,
		"arguments_section": arguments_section.root,
		"arguments_body": arguments_body,
		"output_section": output_section.root,
		"body": body,
		"changes_section": changes_section.root,
		"changes_body": changes_body,
		"diff_section": diff_section.root,
		"diff_body": diff_body,
		"status": status,
		"name": name,
		"arguments": arguments_value,
		"output_length": 0,
		"truncated": false,
	}
	_queue_scroll_to_bottom(follow)


func _tool_detail_section(parent: VBoxContainer, title_text: String, max_height: float) -> Dictionary:
	var section := VBoxContainer.new()
	section.add_theme_constant_override("separation", 2)
	section.set_meta("detail_kind", title_text.to_lower())
	var heading := Label.new()
	heading.text = _t(title_text)
	heading.add_theme_font_size_override("font_size", 11)
	heading.add_theme_color_override("font_color", _editor_color("font_color", Color("d6d9df")))
	section.add_child(heading)
	var body := _tool_detail_label(max_height)
	section.add_child(body)
	parent.add_child(section)
	return {"root": section, "body": body}


func _tool_detail_label(max_height: float) -> RichTextLabel:
	var label := _message_label()
	label.fit_content = false
	label.scroll_active = true
	label.scroll_following = false
	label.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	label.custom_minimum_size.y = TOOL_DETAIL_MIN_HEIGHT
	label.set_meta("tool_detail_body", true)
	label.set_meta("detail_max_height", max_height)
	label.set_meta("resize_pending", false)
	label.set_meta("last_width", -1.0)
	label.add_theme_color_override("default_color", _editor_color("font_color", Color("d7dbe2")))
	label.add_theme_stylebox_override("normal", _tool_detail_text_style())
	label.add_theme_font_size_override("normal_font_size", 12)
	label.add_theme_font_size_override("mono_font_size", 12)
	label.add_theme_constant_override("line_separation", 3)
	label.add_theme_constant_override("text_highlight_h_padding", 0)
	label.add_theme_constant_override("text_highlight_v_padding", 0)
	var code_font := (
		get_theme_font("source", "EditorFonts")
		if has_theme_font("source", "EditorFonts")
		else get_theme_font("mono_font", "RichTextLabel")
	)
	if code_font != null:
		label.add_theme_font_override("normal_font", code_font)
		label.add_theme_font_override("mono_font", code_font)
	label.resized.connect(_on_tool_detail_body_resized.bind(label))
	label.gui_input.connect(_on_tool_detail_scroll_input)
	return label


func _tool_detail_text_style() -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = _editor_color("dark_color_2", Color("1d2025"))
	style.corner_radius_top_left = 3
	style.corner_radius_top_right = 3
	style.corner_radius_bottom_left = 3
	style.corner_radius_bottom_right = 3
	style.content_margin_left = 8
	style.content_margin_top = 6
	style.content_margin_right = 8
	style.content_margin_bottom = 6
	return style


func _on_tool_detail_body_resized(body: RichTextLabel) -> void:
	var previous_width := float(body.get_meta("last_width", -1.0))
	if absf(body.size.x - previous_width) <= 0.5:
		return
	body.set_meta("last_width", body.size.x)
	_queue_tool_detail_body_resize(body)


func _on_tool_detail_scroll_input(event: InputEvent) -> void:
	var mouse_button := event as InputEventMouseButton
	if mouse_button != null:
		if mouse_button.pressed and mouse_button.button_index in [MOUSE_BUTTON_WHEEL_UP, MOUSE_BUTTON_WHEEL_DOWN]:
			_pause_conversation_following()
		return
	if event is InputEventPanGesture or event is InputEventScreenDrag:
		_pause_conversation_following()


func _queue_tool_detail_body_resize(body: RichTextLabel) -> void:
	if not is_instance_valid(body) or bool(body.get_meta("resize_pending", false)):
		return
	body.set_meta("resize_pending", true)
	call_deferred("_resize_tool_detail_body", body)


func _resize_tool_detail_body(body: RichTextLabel) -> void:
	if not is_instance_valid(body):
		return
	body.set_meta("resize_pending", false)
	var background := body.get_theme_stylebox("normal")
	var padding_height := background.get_minimum_size().y if background != null else 0.0
	var content_height := maxf(0.0, body.get_content_height()) + padding_height
	var max_height := float(body.get_meta("detail_max_height", TOOL_DETAIL_MAX_HEIGHT))
	var target_height := clampf(ceilf(content_height), TOOL_DETAIL_MIN_HEIGHT, max_height)
	if absf(body.custom_minimum_size.y - target_height) <= 0.5:
		return
	var minimum_size := body.custom_minimum_size
	minimum_size.y = target_height
	body.custom_minimum_size = minimum_size


func _queue_tool_detail_tree_resize(root: Node) -> void:
	var body := root as RichTextLabel
	if body != null and bool(body.get_meta("tool_detail_body", false)):
		_queue_tool_detail_body_resize(body)
	for child in root.get_children():
		_queue_tool_detail_tree_resize(child)


func _on_tool_details_toggled(expanded: bool, details: VBoxContainer, toggle: Button) -> void:
	var follow := _should_follow_conversation()
	details.visible = expanded
	toggle.icon = _icon_texture("GuiTreeArrowDown" if expanded else "GuiTreeArrowRight")
	toggle.tooltip_text = _t("Hide tool details") if expanded else _t("Show tool details")
	if expanded:
		_queue_tool_detail_tree_resize(details)
	_queue_scroll_to_bottom(follow)


func _set_tool_details_expanded(view: Dictionary, expanded: bool) -> void:
	var details := view.get("details") as VBoxContainer
	var toggle := view.get("toggle") as Button
	if details == null or toggle == null:
		return
	toggle.set_pressed_no_signal(expanded)
	_on_tool_details_toggled(expanded, details, toggle)


func _tool_icon_name(tool_name: String) -> String:
	match tool_name:
		"godot_scene", "scene_apply_operations", "scene_get_tree", "node_get_properties", "game_debug_start", "game_debug_status", "game_capture_screenshot", "game_debug_stop", "game_automation_run", "game_automation_status", "game_automation_cancel", "game_test":
			return "SceneTask"
		"apply_patch":
			return "CodeTask"
		"read_file", "list_files", "search_text", "project_symbol_search", "project_find_references", "project_dependency_graph", "project_context", "godot_api_query", "editor_get_selection", "resource_inspect":
			return "ProjectTask"
		"web_search", "web_open":
			return "WebTask"
		"run_command":
			return "AgentTask"
		_:
			return "AgentTask"


func _tool_title(tool_name: String, arguments: Dictionary) -> String:
	match tool_name:
		"project_context":
			return _t("Referenced project context")
		"list_files":
			var suffix := str(arguments.get("file_suffix", ""))
			return _t("List %s files") % suffix if not suffix.is_empty() else _t("List project files")
		"read_file":
			return _t("Read %s") % str(arguments.get("path", "file"))
		"search_text":
			return _t("Search for %s") % str(arguments.get("query", "text"))
		"project_symbol_search":
			return _t("Search project symbols for %s") % str(arguments.get("query", "symbol"))
		"project_find_references":
			return _t("Find references to %s") % str(arguments.get("name", "symbol"))
		"project_dependency_graph":
			return _t("Inspect dependencies of %s") % str(arguments.get("path", "resource"))
		"godot_api_query":
			var action := str(arguments.get("action", "search"))
			if action == "describe" or action == "inheriters":
				return _t("Query Godot API for %s") % str(arguments.get("class_name", "class"))
			return _t("Search Godot API for %s") % str(arguments.get("query", "class"))
		"web_search":
			return _truncate_tool_title(_t("Search web for %s") % str(arguments.get("query", "text")))
		"web_open":
			return _truncate_tool_title(_t("Open webpage %s") % str(arguments.get("url", "URL")))
		"apply_patch":
			var paths: Dictionary = {}
			var operations_value = arguments.get("operations", [])
			if operations_value is Array:
				for operation_value in operations_value:
					if operation_value is Dictionary:
						var path := str(operation_value.get("path", ""))
						if not path.is_empty():
							paths[path] = true
			if paths.size() == 1:
				return _t("Edit %s") % str(paths.keys()[0])
			if paths.size() > 1:
				return _t("Edit %d files") % paths.size()
			return _t("Edit project files")
		"godot_scene":
			return _t("Edit %s") % str(arguments.get("scene_path", "scene"))
		"scene_apply_operations":
			return _t("Edit leased scene")
		"scene_get_tree":
			return _t("Inspect leased scene tree")
		"editor_get_selection":
			return _t("Inspect editor selection")
		"node_get_properties":
			return _t("Inspect properties %s") % str(arguments.get("node_path", "."))
		"resource_inspect":
			return _t("Inspect resource %s") % str(arguments.get("path", "resource"))
		"game_debug_start":
			var mode := str(arguments.get("mode", "main"))
			if mode == "current":
				return _t("Debug current scene")
			if mode == "scene":
				return _t("Debug %s") % str(arguments.get("scene_path", "scene"))
			return _t("Debug main scene")
		"game_debug_status":
			return _t("Inspect game debug session")
		"game_capture_screenshot":
			return _t("Capture running game frame")
		"game_debug_stop":
			return _t("Stop editor game")
		"game_automation_run":
			return _t("Run game automation")
		"game_automation_status":
			return _t("Inspect game automation")
		"game_automation_cancel":
			return _t("Cancel game automation")
		"game_test":
			var target_value = arguments.get("target", {})
			var target: Dictionary = target_value if target_value is Dictionary else {}
			var mode := str(target.get("mode", arguments.get("mode", "main")))
			if mode == "current":
				return _t("Test current scene")
			if mode == "scene":
				return _t("Test %s") % str(target.get("scene_path", arguments.get("scene_path", "scene")))
			return _t("Test main scene")
		"run_command":
			var compatibility_path := _command_read_compatibility_path(arguments)
			if not compatibility_path.is_empty():
				return _truncate_tool_title(_t("Read %s") % compatibility_path)
			var command_value = arguments.get("command", [])
			if command_value is Array:
				var command_parts := PackedStringArray()
				for part in command_value:
					command_parts.append(str(part))
				return _truncate_tool_title(_t("Run %s") % " ".join(command_parts))
			return _t("Run command")
		_:
			return tool_name.replace("_", " ").capitalize()


func _truncate_tool_title(text: String, max_length: int = 96) -> String:
	if text.length() <= max_length:
		return text
	return "%s..." % text.left(max_length - 3)


func _command_read_compatibility_path(arguments: Dictionary) -> String:
	var command_value = arguments.get("command", [])
	if not command_value is Array or (command_value as Array).size() != 2:
		return ""
	var command: Array = command_value
	var executable := str(command[0]).strip_edges().to_lower()
	if executable != "cat" and executable != "type" and executable != "get-content":
		return ""
	var candidate := str(command[1]).strip_edges()
	if candidate.is_empty() or candidate.begins_with("-"):
		return ""
	if candidate.to_lower().begins_with("res://"):
		candidate = candidate.substr("res://".length())
	return candidate


func _format_tool_arguments(tool_name: String, arguments: Dictionary, value_limit: int = 120) -> String:
	var lines := PackedStringArray()
	match tool_name:
		"project_context":
			lines.append(_t("Context sources: %d") % int(arguments.get("source_count", 0)))
			lines.append(_t("Context characters: %d") % int(arguments.get("character_count", 0)))
			var revision := str(arguments.get("index_revision", ""))
			if not revision.is_empty():
				lines.append(_t("Index revision: %s") % revision)
			if bool(arguments.get("truncated", false)) or bool(arguments.get("index_truncated", false)):
				lines.append(_t("Retrieval was truncated to the safe context budget."))
		"read_file":
			lines.append(_t("Path: %s") % str(arguments.get("path", "")))
		"list_files":
			var suffix := str(arguments.get("file_suffix", ""))
			lines.append(_t("File suffix: %s") % suffix if not suffix.is_empty() else _t("All project files"))
			if arguments.has("limit"):
				lines.append(_t("Limit: %s") % str(arguments.limit))
		"search_text":
			lines.append(_t("Query: %s") % str(arguments.get("query", "")))
			var suffix := str(arguments.get("file_suffix", ""))
			if not suffix.is_empty():
				lines.append(_t("File suffix: %s") % suffix)
			if arguments.has("limit"):
				lines.append(_t("Limit: %s") % str(arguments.limit))
		"project_symbol_search":
			lines.append(_t("Query: %s") % str(arguments.get("query", "")))
			if arguments.has("kinds"):
				lines.append(_t("Kinds: %s") % JSON.stringify(arguments.kinds))
			if arguments.has("path_prefix"):
				lines.append(_t("Path prefix: %s") % str(arguments.path_prefix))
		"project_find_references":
			lines.append(_t("Symbol: %s") % str(arguments.get("name", "")))
			if arguments.has("path_prefix"):
				lines.append(_t("Path prefix: %s") % str(arguments.path_prefix))
		"project_dependency_graph":
			lines.append(_t("Path: %s") % str(arguments.get("path", "")))
			lines.append(_t("Direction: %s") % str(arguments.get("direction", "both")))
			lines.append(_t("Depth: %s") % str(arguments.get("depth", 3)))
		"godot_api_query":
			lines.append(_t("Action: %s") % str(arguments.get("action", "search")))
			if arguments.has("class_name"):
				lines.append(_t("Class: %s") % str(arguments.class_name))
			if arguments.has("query"):
				lines.append(_t("Query: %s") % str(arguments.query))
			if arguments.has("member_query"):
				lines.append(_t("Member query: %s") % str(arguments.member_query))
		"web_search":
			lines.append(_t("Query: %s") % str(arguments.get("query", "")))
			lines.append(_t("Results limit: %s") % str(arguments.get("limit", 5)))
		"web_open":
			lines.append(_t("URL: %s") % str(arguments.get("url", "")))
			lines.append(_t("Content limit: %s characters") % str(arguments.get("max_chars", 20000)))
		"apply_patch":
			var operations_value = arguments.get("operations", [])
			if operations_value is Array:
				for operation_value in operations_value:
					if not operation_value is Dictionary:
						continue
					var action := str(operation_value.get("action", "change"))
					var action_label := _t("Update") if action == "replace" else _t(action.capitalize())
					lines.append("%s  %s" % [action_label, str(operation_value.get("path", ""))])
		"godot_scene", "scene_apply_operations":
			if tool_name == "godot_scene":
				lines.append(_t("Scene: %s") % str(arguments.get("scene_path", "")))
			else:
				lines.append(_t("Live scene: %s") % str(arguments.get("scene_id", "")))
				var revision := str(arguments.get("scene_revision", ""))
				if not revision.is_empty():
					lines.append(_t("Revision: %s") % revision)
			var operations_value = arguments.get("operations", [])
			if operations_value is Array:
				for operation_value in operations_value:
					if not operation_value is Dictionary:
						continue
					var action := str(operation_value.get("action", ""))
					if action == "add_node":
						var parent_path := str(operation_value.get("parent_path", operation_value.get("parent", ".")))
						var node_name := str(operation_value.get("name", "Node"))
						var node_path := node_name if parent_path == "." else "%s/%s" % [parent_path, node_name]
						lines.append(_t("Add %s  %s") % [str(operation_value.get("node_type", "Node")), node_path])
						var properties_value = operation_value.get("properties", {})
						if properties_value is Dictionary:
							var property_names: Array = properties_value.keys()
							property_names.sort()
							for property_name in property_names:
								lines.append(
									_t("  Set %s.%s = %s") % [
										node_path,
										str(property_name),
										_format_scene_tool_value(properties_value[property_name], value_limit),
									]
								)
					elif action == "set_property":
						lines.append(
							_t("Set %s.%s = %s") % [
								str(operation_value.get("node_path", ".")),
								str(operation_value.get("property", "property")),
								_format_scene_tool_value(operation_value.get("value"), value_limit),
							]
						)
					elif action == "set_script":
						var script_path_value = operation_value.get("script_path")
						if script_path_value == null:
							lines.append(_t("Detach script from %s") % str(operation_value.get("node_path", ".")))
						else:
							lines.append(_t("Attach script %s -> %s") % [
								str(script_path_value),
								str(operation_value.get("node_path", ".")),
							])
					elif action == "rename_node":
						lines.append(_t("Rename %s -> %s") % [
							str(operation_value.get("node_path", ".")),
							str(operation_value.get("new_name", "Node")),
						])
					elif action == "remove_node":
						lines.append(_t("Remove %s") % str(operation_value.get("node_path", ".")))
					elif action == "duplicate_node":
						var source_path := str(operation_value.get("node_path", "."))
						var duplicate_parent := str(operation_value.get("parent_path", ""))
						var duplicate_name := str(operation_value.get("name", ""))
						if not duplicate_name.is_empty():
							var duplicate_target := duplicate_name
							if not duplicate_parent.is_empty() and duplicate_parent != ".":
								duplicate_target = "%s/%s" % [duplicate_parent, duplicate_name]
							lines.append(_t("Duplicate %s -> %s") % [source_path, duplicate_target])
						elif not duplicate_parent.is_empty():
							lines.append(_t("Duplicate %s under %s (auto name)") % [source_path, duplicate_parent])
						else:
							lines.append(_t("Duplicate %s (same parent, auto name)") % source_path)
					elif action == "reparent_node":
						var move_target := str(operation_value.get("new_parent_path", "."))
						var moved_name := str(operation_value.get("new_name", ""))
						if not moved_name.is_empty():
							move_target = moved_name if move_target == "." else "%s/%s" % [move_target, moved_name]
						lines.append(_t("Move %s -> %s") % [str(operation_value.get("node_path", ".")), move_target])
						if operation_value.has("index"):
							lines.append(_t("  Child index: %s") % str(operation_value.index))
						lines.append(
							_t("  Preserve global transform: %s") % str(
								bool(operation_value.get("keep_global_transform", true))
							)
						)
					elif action == "instantiate_scene":
						var instance_parent := str(operation_value.get("parent_path", "."))
						var instance_name := str(operation_value.get("name", ""))
						var instance_target := instance_parent
						if not instance_name.is_empty():
							instance_target = instance_name if instance_parent == "." else "%s/%s" % [instance_parent, instance_name]
						else:
							instance_target += _t(" (scene root name)")
						lines.append(_t("Instantiate %s -> %s") % [
							str(operation_value.get("scene_path", "")),
							instance_target,
						])
						var instance_properties = operation_value.get("properties", {})
						if instance_properties is Dictionary:
							var instance_property_names: Array = instance_properties.keys()
							instance_property_names.sort()
							for property_name in instance_property_names:
								lines.append(_t("  Set %s = %s") % [
									str(property_name),
									_format_scene_tool_value(instance_properties[property_name], value_limit),
								])
		"scene_get_tree":
			if arguments.has("scene_id"):
				lines.append(_t("Scene: %s") % str(arguments.scene_id))
			lines.append(_t("Root: %s") % str(arguments.get("root_path", ".")))
			lines.append(_t("Max depth: %s") % str(arguments.get("max_depth", 6)))
			lines.append(_t("Max nodes: %s") % str(arguments.get("max_nodes", 200)))
			if bool(arguments.get("include_internal", false)):
				lines.append(_t("Include internal nodes: true"))
		"editor_get_selection":
			lines.append(_t("Limit: %s") % str(arguments.get("limit", 64)))
		"node_get_properties":
			lines.append(_t("Node: %s") % str(arguments.get("node_path", ".")))
			if arguments.has("scene_id"):
				lines.append(_t("Scene: %s") % str(arguments.scene_id))
			if arguments.has("property_names"):
				lines.append(_t("Properties: %s") % JSON.stringify(arguments.property_names))
			lines.append(_t("Limit: %s") % str(arguments.get("max_properties", 128)))
		"resource_inspect":
			lines.append(_t("Resource: %s") % str(arguments.get("path", "")))
			if arguments.has("property_names"):
				lines.append(_t("Properties: %s") % JSON.stringify(arguments.property_names))
			lines.append(_t("Limit: %s") % str(arguments.get("max_properties", 128)))
			lines.append(_t("Dependencies: %s") % str(bool(arguments.get("include_dependencies", true))))
		"game_debug_start":
			var mode := str(arguments.get("mode", "main"))
			lines.append(_t("Mode: %s") % _game_debug_mode_label(mode))
			var scene_path := str(arguments.get("scene_path", ""))
			if mode == "scene" and not scene_path.is_empty():
				lines.append(_t("Scene: %s") % scene_path)
			elif mode == "current" and not scene_path.is_empty():
				lines.append(_t("Supplied scene path ignored; using the task's frozen current scene."))
			lines.append(
				_t("Game launch will be approved automatically.")
				if _auto_approve_edits_enabled
				else _t("Requires approval before launching.")
			)
		"game_debug_status":
			lines.append(_t("Recent output limit: %s") % str(arguments.get("history_limit", 100)))
			if int(arguments.get("after_seq", 0)) > 0:
				lines.append(_t("After sequence: %s") % str(arguments.after_seq))
		"game_capture_screenshot":
			lines.append(_t("Run ID: %s") % str(arguments.get("run_id", "")))
			lines.append(_t("Maximum image dimension: %s") % str(arguments.get("max_dimension", 1600)))
			lines.append(_t("Image detail: %s") % str(arguments.get("detail", "high")))
		"game_debug_stop":
			lines.append(_t("Only a game started by GodotX can be stopped."))
			lines.append(_t("Run ID: %s") % str(arguments.get("run_id", "")))
		"game_automation_run":
			lines.append(_t("Run ID: %s") % str(arguments.get("run_id", "")))
			var steps_value = arguments.get("steps", [])
			var automation_steps: Array = steps_value if steps_value is Array else []
			lines.append(_t("Steps: %d") % automation_steps.size())
			lines.append(_t("Stop on failure: %s") % _localized_boolean_label(
				bool(arguments.get("stop_on_failure", true))
			))
			for step_index in automation_steps.size():
				lines.append(_format_game_automation_step(step_index, automation_steps[step_index], value_limit))
		"game_automation_status", "game_automation_cancel":
			lines.append(_t("Run ID: %s") % str(arguments.get("run_id", "")))
			lines.append(_t("Automation ID: %s") % str(arguments.get("automation_id", "")))
		"game_test":
			var target_value = arguments.get("target", {})
			var target: Dictionary = target_value if target_value is Dictionary else {}
			var mode := str(target.get("mode", arguments.get("mode", "main")))
			lines.append(_t("Mode: %s") % _game_debug_mode_label(mode))
			var scene_path := str(target.get("scene_path", arguments.get("scene_path", "")))
			if mode == "scene" and not scene_path.is_empty():
				lines.append(_t("Scene: %s") % scene_path)
			lines.append(
				_t("Game launch will be approved automatically.")
				if _auto_approve_edits_enabled
				else _t("Requires approval before launching.")
			)
			var steps_value = arguments.get("steps", [])
			var test_steps: Array = steps_value if steps_value is Array else []
			lines.append(_t("Steps: %d") % test_steps.size())
			lines.append(_t("Stop on failure: %s") % _localized_boolean_label(
				bool(arguments.get("stop_on_failure", true))
			))
			lines.append(_t("Cleanup policy: %s") % _game_test_cleanup_label(str(arguments.get("cleanup", "always"))))
			lines.append(_t("Visual capture: %s") % _game_test_capture_label(str(arguments.get("capture", "never"))))
			if str(arguments.get("capture", "never")) != "never":
				lines.append(_t("Maximum image dimension: %s") % str(arguments.get("capture_max_dimension", 1600)))
				lines.append(_t("Image detail: %s") % str(arguments.get("capture_detail", "high")))
			if arguments.has("ready_timeout_ms"):
				lines.append(_t("Ready timeout: %s ms") % str(arguments.get("ready_timeout_ms", "")))
			if arguments.has("automation_timeout_ms"):
				lines.append(_t("Automation timeout: %s ms") % str(arguments.get("automation_timeout_ms", "")))
			for step_index in test_steps.size():
				lines.append(_format_game_automation_step(step_index, test_steps[step_index], value_limit))
		"run_command":
			var compatibility_path := _command_read_compatibility_path(arguments)
			if not compatibility_path.is_empty():
				lines.append(_t("Path: %s") % compatibility_path)
				return "\n".join(lines)
			var command_value = arguments.get("command", [])
			if command_value is Array:
				var command_parts := PackedStringArray()
				for part in command_value:
					command_parts.append(str(part))
				lines.append(_t("Command: %s") % " ".join(command_parts))
			if arguments.has("timeout_ms"):
				lines.append(_t("Timeout: %s ms") % str(arguments.timeout_ms))
		_:
			return JSON.stringify(arguments, "  ")
	return "\n".join(lines)


func _format_scene_tool_value(value: Variant, value_limit: int = 120) -> String:
	if value is Dictionary:
		var tag := str(value.get("godot_type", ""))
		if tag == "Resource":
			var resource_path := str(value.get("path", ""))
			var resource_uid := str(value.get("uid", ""))
			var expected_type := str(value.get("expected_type", value.get("resource_type", "Resource")))
			var locator := resource_path
			if locator.is_empty():
				locator = resource_uid
			elif not resource_uid.is_empty():
				locator += " [%s]" % resource_uid
			return _truncate_tool_title("%s (%s)" % [locator, expected_type], value_limit)
		if tag == "NodePath":
			return _truncate_tool_title("NodePath(%s)" % str(value.get("path", "")), value_limit)
	return _truncate_tool_title(JSON.stringify(value), value_limit)


func _format_tool_arguments_value(tool_name: String, arguments_value: Variant) -> String:
	if arguments_value is Dictionary:
		return _format_tool_arguments(tool_name, arguments_value)
	if arguments_value is String:
		return str(arguments_value)
	return JSON.stringify(arguments_value, "  ")


func _format_tool_output(tool_name: String, output: Dictionary) -> String:
	if output.has("error") and tool_name != "game_test":
		return _t("Error: %s") % _display_error(str(output.error))
	match tool_name:
		"project_context":
			var lines := PackedStringArray()
			var sources_value: Variant = output.get("sources", [])
			if sources_value is Array:
				for source_value in sources_value:
					if not source_value is Dictionary:
						continue
					var source: Dictionary = source_value
					var source_path := str(source.get("path", ""))
					var source_line := int(source.get("line", 0))
					lines.append("%s%s" % [source_path, ":%d" % source_line if source_line > 0 else ""])
					var reasons_value: Variant = source.get("reasons", [])
					if reasons_value is Array and not reasons_value.is_empty():
						var reasons := PackedStringArray()
						for reason_value in reasons_value:
							reasons.append(str(reason_value))
						lines.append(_t("Matched by: %s") % ", ".join(reasons))
					var symbols_value: Variant = source.get("symbols", [])
					if symbols_value is Array and not symbols_value.is_empty():
						var symbols := PackedStringArray()
						for symbol_value in symbols_value.slice(0, 8):
							if symbol_value is Dictionary:
								symbols.append("L%s %s %s" % [
									str(symbol_value.get("line", "")),
									str(symbol_value.get("kind", "")),
									str(symbol_value.get("name", "")),
								])
						if not symbols.is_empty():
							lines.append(_t("Symbols:") + "\n- " + "\n- ".join(symbols))
					var snippet := str(source.get("snippet", ""))
					if not snippet.is_empty():
						lines.append(snippet)
			return "\n\n".join(lines)
		"read_file":
			return str(output.get("content", ""))
		"list_files":
			var lines := PackedStringArray()
			var files_value = output.get("files", [])
			if files_value is Array:
				for file_value in files_value:
					lines.append(str(file_value))
			return "\n".join(lines)
		"search_text":
			var lines := PackedStringArray()
			var matches_value = output.get("matches", [])
			if matches_value is Array:
				for match_value in matches_value:
					if match_value is Dictionary:
						lines.append("%s:%s  %s" % [
							str(match_value.get("path", "")),
							str(match_value.get("line", "")),
							str(match_value.get("text", "")),
						])
			return "\n".join(lines)
		"web_search":
			var lines := PackedStringArray()
			var source := str(output.get("source", ""))
			if not source.is_empty():
				lines.append(_t("Search provider: %s") % source)
			var results_value = output.get("results", [])
			if results_value is Array:
				for result_value in results_value:
					if not result_value is Dictionary:
						continue
					var title := str(result_value.get("title", ""))
					var url := str(result_value.get("url", ""))
					var snippet := str(result_value.get("snippet", ""))
					lines.append("%s\n%s" % [title, url])
					if not snippet.is_empty():
						lines.append(snippet)
			return "\n\n".join(lines)
		"web_open":
			var lines := PackedStringArray()
			var title := str(output.get("title", ""))
			if not title.is_empty():
				lines.append(title)
			var final_url := str(output.get("final_url", ""))
			if not final_url.is_empty():
				lines.append(final_url)
			var content := str(output.get("content", ""))
			if not content.is_empty():
				lines.append(content)
			if bool(output.get("truncated", false)):
				lines.append(_t("Web content was truncated."))
			return "\n\n".join(lines)
		"run_command":
			if str(output.get("handled_by", "")) == "read_file":
				return str(output.get("content", ""))
			var lines := PackedStringArray()
			var command_output := str(output.get("output", "")).trim_suffix("\n")
			if not command_output.is_empty():
				lines.append(command_output)
			if output.has("exit_code"):
				lines.append(_t("Exit code: %s") % str(output.exit_code))
			var signal_value = output.get("signal")
			if signal_value != null and not str(signal_value).is_empty():
				lines.append(_t("Signal: %s") % str(signal_value))
			return "\n\n".join(lines)
		"apply_patch", "godot_scene":
			if output.has("ok") and not bool(output.ok):
				return _t("Tool failed")
			return ""
		"scene_apply_operations":
			if output.has("ok") and not bool(output.ok):
				return _t("Tool failed")
			var lines := PackedStringArray()
			lines.append(_t("Applied %d live scene operations.") % int(output.get("operation_count", output.get("applied", 0))))
			var action_name := str(output.get("undo_action", ""))
			if not action_name.is_empty():
				lines.append(_t("Undo action: %s") % action_name)
			var scene_path := str(output.get("scene_path", ""))
			if not scene_path.is_empty():
				lines.append(_t("Scene: %s") % scene_path)
			var scene_revision := str(output.get("scene_revision", ""))
			if not scene_revision.is_empty():
				lines.append(_t("Revision: %s") % scene_revision)
			if bool(output.get("result_truncated", false)):
				lines.append(_t(str(output.get("warning", "Detailed change output was truncated."))))
			return "\n".join(lines)
		"game_debug_start":
			return _format_game_debug_start_output(output)
		"game_debug_status":
			return _format_game_debug_status_output(output)
		"game_capture_screenshot":
			return _format_game_screenshot_output(output)
		"game_debug_stop":
			return _format_game_debug_stop_output(output)
		"game_automation_run", "game_automation_status", "game_automation_cancel":
			return _format_game_automation_output(output)
		"game_test":
			return _format_game_test_output(output)
		_:
			return JSON.stringify(output, "  ")


func _format_game_automation_step(index: int, step_value: Variant, value_limit: int) -> String:
	if not step_value is Dictionary:
		return _t("%d. Invalid step: %s") % [index + 1, _truncate_tool_title(JSON.stringify(step_value), value_limit)]
	var step: Dictionary = step_value
	var step_type := str(step.get("type", ""))
	match step_type:
		"wait_frames":
			return _t("%d. Wait %s frames") % [
				index + 1,
				_format_automation_integer_argument(step.get("frames", 0)),
			]
		"click_control":
			return _t("%d. Click %s (button %s)") % [
				index + 1,
				str(step.get("node_path", "")),
				_format_automation_integer_argument(step.get("button", 1)),
			]
		"press_action":
			var action := str(step.get("action", ""))
			if not bool(step.get("pressed", true)):
				return _t("%d. Release action %s") % [index + 1, action]
			return _t("%d. Press action %s for %s frames") % [
				index + 1,
				action,
				_format_automation_integer_argument(step.get("duration_frames", 1)),
			]
		"assert_node":
			var node_path := str(step.get("node_path", ""))
			var check := str(step.get("check", "exists"))
			if check == "exists":
				return _t("%d. Assert %s exists = %s (timeout %s frames)") % [
					index + 1,
					node_path,
					str(bool(step.get("exists", true))),
					_format_automation_integer_argument(step.get("timeout_frames", 0)),
				]
			return _t("%d. Assert %s.%s %s %s (timeout %s frames)") % [
				index + 1,
				node_path,
				str(step.get("property", "")),
				check,
				_truncate_tool_title(JSON.stringify(step.get("value")), value_limit),
				_format_automation_integer_argument(step.get("timeout_frames", 0)),
			]
		_:
			return _t("%d. Unknown step type: %s") % [index + 1, step_type]


func _format_automation_integer_argument(value: Variant) -> String:
	if value is int:
		return str(value)
	if value is float:
		var number: float = float(value)
		if not is_nan(number) and not is_inf(number) and number == floor(number):
			return str(int(number))
	return str(value)


func _format_game_automation_output(output: Dictionary) -> String:
	var lines := PackedStringArray()
	var state := str(output.get("state", ""))
	if not state.is_empty():
		lines.append(_t("State: %s") % _game_automation_state_label(state))
	var automation_id := str(output.get("automation_id", ""))
	if not automation_id.is_empty():
		lines.append(_t("Automation ID: %s") % automation_id)
	var run_id := str(output.get("run_id", ""))
	if not run_id.is_empty():
		lines.append(_t("Run ID: %s") % run_id)
	var step_count := int(output.get("step_count", 0))
	var current_step := int(output.get("current_step", 0))
	if step_count > 0:
		lines.append(_t("Progress: %d/%d") % [current_step, step_count])
	if bool(output.get("cancel_requested", false)):
		lines.append(_t("Cancellation requested."))
	var started_at_ms := int(output.get("started_at_ms", 0))
	var ended_at_ms := int(output.get("ended_at_ms", 0))
	# Runtime timestamps share an origin with each other, but not with the editor process.
	if started_at_ms > 0 and ended_at_ms >= started_at_ms:
		lines.append(_t("Duration: %s") % _format_game_debug_duration(ended_at_ms - started_at_ms))
	var results_value = output.get("results", [])
	if results_value is Array and not results_value.is_empty():
		lines.append("")
		lines.append(_t("Step results (%d):") % results_value.size())
		for result_value in results_value:
			lines.append(_format_game_automation_result(result_value))
	var failure := str(output.get("failure", ""))
	if not failure.is_empty():
		lines.append(_t("Failure: %s") % failure)
	return "\n".join(lines)


func _game_automation_state_label(state: String) -> String:
	match state:
		"queued":
			return _t("Queued")
		"running":
			return _t("Running")
		"passed":
			return _t("Passed")
		"failed":
			return _t("Failed")
		"cancelled":
			return _t("Cancelled")
		_:
			return state


func _game_test_cleanup_label(policy: String) -> String:
	match policy:
		"on_success":
			return _t("On success")
		"never":
			return _t("Never")
		_:
			return _t("Always")


func _game_test_capture_label(policy: String) -> String:
	match policy:
		"after":
			return _t("After automation")
		"on_failure":
			return _t("On failure")
		"always":
			return _t("Always")
		_:
			return _t("Never")


func _format_game_screenshot_output(output: Dictionary) -> String:
	var lines := PackedStringArray()
	lines.append(_t("Captured frame: %s x %s") % [
		str(output.get("width", 0)),
		str(output.get("height", 0)),
	])
	if output.has("frame"):
		lines.append(_t("Frame: %s") % str(output.get("frame", 0)))
	var scene_path := str(output.get("scene_path", ""))
	if not scene_path.is_empty():
		lines.append(_t("Scene: %s") % scene_path)
	var attachment_id := str(output.get("attachment_id", ""))
	if not attachment_id.is_empty():
		lines.append(_t("Attachment: %s") % attachment_id.left(12))
	return "\n".join(lines)


func _localized_boolean_label(value: bool) -> String:
	return _t("Yes") if value else _t("No")


func _format_game_test_output(output: Dictionary) -> String:
	var lines := PackedStringArray()
	var state := str(output.get("state", ""))
	if not state.is_empty():
		lines.append(_t("State: %s") % _game_test_state_label(state))
	var run_id := str(output.get("run_id", ""))
	var automation_id := str(output.get("automation_id", ""))
	var launch_value = output.get("launch", null)
	if launch_value is Dictionary:
		var launch: Dictionary = launch_value
		run_id = _game_test_nested_identity(launch, "run_id", run_id)
		lines.append(_t("Launch: %s") % _game_test_phase_summary(launch))
		_append_game_test_output_entries(lines, launch)
	var automation_value = output.get("automation", null)
	if automation_value is Dictionary:
		var automation: Dictionary = automation_value
		automation_id = _game_test_nested_identity(automation, "automation_id", automation_id)
		run_id = _game_test_nested_identity(automation, "run_id", run_id)
		lines.append(_t("Automation: %s") % _game_test_phase_summary(automation))
		var automation_report := _game_test_nested_report(automation, "status", "start")
		var step_count := int(automation_report.get("step_count", output.get("step_count", 0)))
		var current_step := int(automation_report.get("current_step", output.get("current_step", 0)))
		if step_count > 0:
			lines.append(_t("Progress: %d/%d") % [current_step, step_count])
		var results_value = automation_report.get("results", [])
		if results_value is Array and not results_value.is_empty():
			lines.append(_t("Step results (%d):") % results_value.size())
			for result_value in results_value:
				lines.append(_format_game_automation_result(result_value))
	var cleanup_value = output.get("cleanup", null)
	if cleanup_value != null:
		lines.append(_t("Cleanup: %s") % _game_test_phase_summary(cleanup_value))
	var visual_value = output.get("visual", null)
	if visual_value is Dictionary:
		lines.append(_t("Visual capture: %s") % _game_test_phase_summary(visual_value))
	if not run_id.is_empty():
		lines.append(_t("Run ID: %s") % run_id)
	if not automation_id.is_empty():
		lines.append(_t("Automation ID: %s") % automation_id)
	if output.has("stopped"):
		lines.append(
			_t("Game stopped after test.")
			if bool(output.get("stopped", false))
			else _t("Game remains running after test.")
		)
	var timings_value = output.get("timings_ms", null)
	if timings_value is Dictionary:
		var timings: Dictionary = timings_value
		var total_ms := int(timings.get("total", timings.get("total_ms", 0)))
		if total_ms > 0:
			lines.append(_t("Total duration: %s") % _format_game_debug_duration(total_ms))
		var phase_timings := PackedStringArray()
		for phase in ["ready", "automation", "cleanup"]:
			if timings.has(phase):
				phase_timings.append("%s %s" % [
					_game_test_timing_phase_label(phase),
					_format_game_debug_duration(int(timings.get(phase, 0))),
				])
		if not phase_timings.is_empty():
			lines.append(_t("Phase timings: %s") % ", ".join(phase_timings))
	var failure := _game_test_failure_text(output.get("failure", ""))
	if failure.is_empty() and automation_value is Dictionary:
		var automation_failure_container: Dictionary = automation_value
		var automation_failure_report := _game_test_nested_report(
			automation_failure_container,
			"status",
			"start"
		)
		failure = _game_test_failure_text(automation_failure_report.get("failure", ""))
	var error_text := _game_test_failure_text(output.get("error", ""))
	if failure.is_empty():
		failure = error_text
	if not failure.is_empty():
		lines.append(_t("Failure: %s") % _display_error(failure))
	var warning := _game_test_nested_diagnostic(output, "warning")
	if not warning.is_empty():
		lines.append(_t("Warning: %s") % warning)
	return "\n".join(lines)


func _game_test_phase_summary(value: Variant) -> String:
	if value is Dictionary:
		var phase: Dictionary = value
		if bool(phase.get("already_stopped", false)):
			return _t("Already stopped")
		if phase.has("attempted") and not bool(phase.get("attempted", false)):
			return _t("Skipped")
		var state := str(phase.get("state", ""))
		if not state.is_empty():
			return _game_test_state_label(state)
		if bool(phase.get("skipped", false)):
			return _t("Skipped")
		if bool(phase.get("stopped", false)):
			return _t("Stopped")
		if bool(phase.get("stop_requested", false)):
			return _t("Stop requested")
		if bool(phase.get("probe_active", false)) or bool(phase.get("probe_confirmed", false)):
			return _t("Ready")
		if bool(phase.get("playing", false)):
			return _t("Running")
		if phase.has("ok"):
			return _t("Passed") if bool(phase.get("ok", false)) else _t("Failed")
		for nested_key in ["status", "capture", "stop", "cancel", "start"]:
			var nested_value = phase.get(nested_key, null)
			if nested_value is Dictionary:
				return _game_test_phase_summary(nested_value)
		return _t("Done")
	if value is bool:
		return _t("Passed") if bool(value) else _t("Failed")
	var text := str(value)
	return _game_test_state_label(text) if not text.is_empty() else _t("Done")


func _game_test_state_label(state: String) -> String:
	match state:
		"validating":
			return _t("Validating")
		"starting", "launching":
			return _t("Starting")
		"waiting_for_probe", "waiting":
			return _t("Waiting for runtime probe")
		"running_automation":
			return _t("Running automation")
		"cleaning_up":
			return _t("Cleaning up")
		"completed":
			return _t("Completed")
		"ready":
			return _t("Ready")
		"stopped":
			return _t("Stopped")
		"skipped":
			return _t("Skipped")
		"timed_out", "timeout":
			return _t("Timed out")
		"launch_failed":
			return _t("Launch failed")
		"ready_timeout":
			return _t("Ready timed out")
		"automation_failed":
			return _t("Automation failed")
		"automation_timeout":
			return _t("Automation timed out")
		"cleanup_failed":
			return _t("Cleanup failed")
		"visual_capture_failed":
			return _t("Visual capture failed")
		"already_stopped":
			return _t("Already stopped")
		_:
			return _game_automation_state_label(state)


func _game_test_failure_text(value: Variant) -> String:
	if value == null:
		return ""
	if value is Dictionary or value is Array:
		return JSON.stringify(value)
	return str(value)


func _game_test_nested_report(container: Dictionary, primary_key: String, fallback_key: String) -> Dictionary:
	var primary_value = container.get(primary_key, null)
	if primary_value is Dictionary:
		return primary_value
	var fallback_value = container.get(fallback_key, null)
	if fallback_value is Dictionary:
		return fallback_value
	return container


func _game_test_nested_identity(container: Dictionary, identity_key: String, current: String) -> String:
	if not current.is_empty():
		return current
	var direct := str(container.get(identity_key, ""))
	if not direct.is_empty():
		return direct
	for nested_key in ["start", "status", "stop", "cancel"]:
		var nested_value = container.get(nested_key, null)
		if nested_value is Dictionary:
			var candidate := str(nested_value.get(identity_key, ""))
			if not candidate.is_empty():
				return candidate
	return ""


func _game_test_nested_diagnostic(container: Dictionary, diagnostic_key: String) -> String:
	var direct := _game_test_failure_text(container.get(diagnostic_key, ""))
	if not direct.is_empty():
		return direct
	for nested_key in ["launch", "automation", "cleanup", "start", "status", "stop", "cancel"]:
		var nested_value = container.get(nested_key, null)
		if nested_value is Dictionary:
			var nested := _game_test_nested_diagnostic(nested_value, diagnostic_key)
			if not nested.is_empty():
				return nested
	return ""


func _append_game_test_output_entries(lines: PackedStringArray, launch: Dictionary) -> void:
	var report := _game_test_nested_report(launch, "status", "start")
	var entries_value = report.get("entries", report.get("logs", []))
	if not entries_value is Array or entries_value.is_empty():
		return
	var entries: Array = entries_value
	var start_index := maxi(0, entries.size() - GAME_TEST_LOG_ENTRY_LIMIT)
	if start_index > 0:
		lines.append(_t("%d earlier output records omitted.") % start_index)
	lines.append(_t("Recent test output (%d):") % (entries.size() - start_index))
	for entry_index in range(start_index, entries.size()):
		lines.append(_truncate_tool_title(
			_format_game_debug_entry(entries[entry_index]),
			GAME_TEST_LOG_LINE_LIMIT
		))


func _game_test_timing_phase_label(phase: String) -> String:
	match phase:
		"ready":
			return _t("ready")
		"automation":
			return _t("automation")
		_:
			return _t("cleanup")


func _format_game_automation_result(result_value: Variant) -> String:
	if not result_value is Dictionary:
		return JSON.stringify(result_value)
	var result: Dictionary = result_value
	var step_index := int(result.get("step_index", result.get("index", -1)))
	var prefix := "#%d" % (step_index + 1) if step_index >= 0 else "-"
	var step_type := str(result.get("type", ""))
	if not step_type.is_empty():
		prefix += " %s" % step_type
	var message := str(result.get("message", result.get("error", "")))
	if not message.is_empty():
		return "%s: %s" % [prefix, message]
	if result.has("ok"):
		return "%s: %s" % [prefix, _t("Passed") if bool(result.get("ok", false)) else _t("Failed")]
	return "%s: %s" % [prefix, JSON.stringify(result)]


func _game_debug_mode_label(mode: String) -> String:
	match mode:
		"current":
			return _t("Current editor scene")
		"scene":
			return _t("Specified scene")
		_:
			return _t("Main project scene")


func _format_game_debug_start_output(output: Dictionary) -> String:
	var lines := PackedStringArray()
	var playing := bool(output.get("playing", false))
	var launch_requested := bool(output.get("launch_requested", output.get("started", output.get("ok", false))))
	if playing:
		lines.append(_t("Game is running in the editor."))
	elif launch_requested:
		lines.append(_t("Game launch requested in the editor."))
	else:
		lines.append(_t("Game debug session prepared."))
	var mode := str(output.get("mode", ""))
	if not mode.is_empty():
		lines.append(_t("Mode: %s") % _game_debug_mode_label(mode))
	_append_game_debug_identity(lines, output)
	return "\n".join(lines)


func _format_game_debug_status_output(output: Dictionary) -> String:
	var lines := PackedStringArray()
	var playing := bool(output.get("playing", false))
	var breaked := bool(output.get("breaked", output.get("paused", false)))
	var owned := bool(output.get("owned", false))
	var stop_requested := bool(output.get("stop_requested", false))
	var armed := bool(output.get("armed", false))
	if playing and stop_requested:
		lines.append(_t("State: stopping"))
	elif playing and breaked:
		lines.append(_t("State: paused at breakpoint"))
	elif playing:
		lines.append(_t("State: running"))
	elif owned or armed:
		lines.append(_t("State: launch requested"))
	else:
		lines.append(_t("State: not running"))
	var mode := str(output.get("mode", ""))
	if not mode.is_empty():
		lines.append(_t("Mode: %s") % _game_debug_mode_label(mode))
	_append_game_debug_identity(lines, output)
	if output.has("elapsed_ms"):
		lines.append(_t("Elapsed: %s") % _format_game_debug_duration(int(output.get("elapsed_ms", 0))))
	if bool(output.get("probe_active", false)):
		lines.append(_t("Runtime probe: connected"))
	elif bool(output.get("probe_confirmed", false)):
		lines.append(_t("Runtime probe: confirmed during run"))
	elif breaked:
		lines.append(_t("Runtime probe: game paused before handshake"))
	elif playing or owned:
		lines.append(_t("Runtime probe: waiting"))
	var probe_error := str(output.get("runtime_probe_error", ""))
	if not probe_error.is_empty():
		lines.append(_t("Runtime probe error: %s") % probe_error)
	var sessions_value = output.get("sessions", [])
	if sessions_value is Array and not sessions_value.is_empty():
		lines.append(_t("Debugger sessions: %d") % sessions_value.size())
	var dropped := int(output.get(
		"discarded_entries",
		output.get("dropped", output.get("dropped_count", 0))
	))
	if dropped > 0:
		lines.append(_t("Dropped output records: %d") % dropped)
	if bool(output.get("truncated", false)):
		lines.append(_t("Output history was truncated."))
	if bool(output.get("has_more", false)):
		lines.append(_t("More output is available after sequence %s.") % str(output.get("next_seq", 0)))
	var entries_value = output.get("entries", output.get("logs", []))
	if entries_value is Array and not entries_value.is_empty():
		lines.append("")
		lines.append(_t("Recent output (%d):") % entries_value.size())
		for entry_value in entries_value:
			lines.append(_format_game_debug_entry(entry_value))
	return "\n".join(lines)


func _format_game_debug_stop_output(output: Dictionary) -> String:
	var lines := PackedStringArray()
	var stopped := bool(output.get("stopped", false))
	var stop_requested := bool(output.get("stop_requested", false))
	var playing := bool(output.get("playing", false))
	if stopped or stop_requested:
		lines.append(_t("Stop requested for the GodotX game."))
	elif not playing:
		lines.append(_t("No GodotX-owned game is running."))
	else:
		lines.append(_t("Game stop request completed."))
	_append_game_debug_identity(lines, output)
	return "\n".join(lines)


func _append_game_debug_identity(lines: PackedStringArray, output: Dictionary) -> void:
	var scene_path := ""
	for scene_key in ["scene_path", "playing_scene_path", "playing_scene", "requested_scene_path", "requested_scene"]:
		var candidate := str(output.get(scene_key, ""))
		if not candidate.is_empty():
			scene_path = candidate
			break
	if not scene_path.is_empty():
		lines.append(_t("Scene: %s") % scene_path)
	var run_id := str(output.get("run_id", ""))
	if not run_id.is_empty():
		lines.append(_t("Run ID: %s") % run_id)


func _format_game_debug_duration(elapsed_ms: int) -> String:
	if elapsed_ms < 1000:
		return _t("%d ms") % max(elapsed_ms, 0)
	var total_seconds := maxi(elapsed_ms / 1000, 0)
	var minutes := total_seconds / 60
	var seconds := total_seconds % 60
	if minutes > 0:
		return _t("%dm %ds") % [minutes, seconds]
	return _t("%ds") % seconds


func _format_game_debug_entry(entry_value: Variant) -> String:
	if not entry_value is Dictionary:
		return str(entry_value)
	var entry: Dictionary = entry_value
	var level := str(entry.get("level", ""))
	if level.is_empty():
		level = str(entry.get("kind", "info"))
	level = level.to_upper()
	var message := str(entry.get(
		"message",
		entry.get("text", entry.get("event", entry.get("code", "")))
	)).strip_edges()
	if message.is_empty():
		message = JSON.stringify(entry)
	var location := str(entry.get("file", ""))
	var line_number := int(entry.get("line", 0))
	if not location.is_empty() and line_number > 0:
		location += ":%d" % line_number
	if not location.is_empty():
		return "[%s] %s  (%s)" % [level, message, location]
	return "[%s] %s" % [level, message]


func _format_changed_files(files_value: Variant) -> String:
	if not files_value is Array:
		return ""
	var lines := PackedStringArray()
	for file_value in files_value:
		var path := ""
		var kind := "update"
		if file_value is Dictionary:
			path = str(file_value.get("path", ""))
			kind = str(file_value.get("kind", "update"))
		else:
			path = str(file_value)
		if path.is_empty():
			continue
		var kind_label := _t("Modified")
		if kind == "create":
			kind_label = _t("Created")
		elif kind == "delete":
			kind_label = _t("Deleted")
		lines.append("%s  %s" % [kind_label, path])
	return "\n".join(lines)


func _format_editor_changes(changes_value: Variant) -> String:
	if not changes_value is Array:
		return ""
	var lines := PackedStringArray()
	for change_value in changes_value:
		if not change_value is Dictionary:
			continue
		var action := str(change_value.get("action", change_value.get("kind", "")))
		if action == "add_node":
			var parent_path := str(change_value.get("parent_path", change_value.get("parent", ".")))
			var node_name := str(change_value.get("name", "Node"))
			var node_path := str(change_value.get("node_path", ""))
			if node_path.is_empty():
				node_path = node_name if parent_path == "." else "%s/%s" % [parent_path, node_name]
			lines.append(_t("Created  %s (%s)") % [node_path, str(change_value.get("node_type", "Node"))])
		elif action == "remove_node":
			lines.append(_t("Deleted  %s") % str(change_value.get("node_path", "")))
		elif action == "rename_node":
			lines.append(_t("Modified  %s -> %s") % [
				str(change_value.get("node_path", "")),
				str(change_value.get("new_name", "")),
			])
		elif action == "set_property":
			var property_line := _t("Modified  %s.%s") % [
				str(change_value.get("node_path", ".")),
				str(change_value.get("property", "property")),
			]
			if change_value.has("before") or change_value.has("after"):
				property_line += _t("  %s -> %s") % [
					_format_scene_tool_value(change_value.get("before"), 96),
					_format_scene_tool_value(change_value.get("after"), 96),
				]
			lines.append(property_line)
		elif action == "set_script":
			var script_line := _t("Modified  %s.script") % str(change_value.get("node_path", "."))
			if change_value.has("before") or change_value.has("after"):
				script_line += _t("  %s -> %s") % [
					_format_scene_tool_value(change_value.get("before"), 96),
					_format_scene_tool_value(change_value.get("after"), 96),
				]
			lines.append(script_line)
		elif action == "duplicate_node":
			lines.append(_t("Created  %s (copy of %s)") % [
				str(change_value.get("node_path", change_value.get("new_path", ""))),
				str(change_value.get("source_path", "")),
			])
		elif action == "instantiate_scene":
			lines.append(_t("Created  %s (instance of %s)") % [
				str(change_value.get("node_path", change_value.get("new_path", ""))),
				str(change_value.get("scene_path", "")),
			])
		elif action == "reparent_node":
			lines.append(_t("Modified  %s -> %s") % [
				str(change_value.get("old_path", change_value.get("node_path", ""))),
				str(change_value.get("new_path", "")),
			])
	return "\n".join(lines)


static func _diff_line_role(line: String) -> StringName:
	if line.begins_with("--- ") or line.begins_with("+++ "):
		return &"header"
	if (
		line.begins_with("diff --git ")
		or line.begins_with("index ")
		or line.begins_with("new file mode ")
		or line.begins_with("deleted file mode ")
		or line.begins_with("\\ No newline at end of file")
	):
		return &"metadata"
	if line.begins_with("@@"):
		return &"hunk"
	if line.begins_with("+"):
		return &"addition"
	if line.begins_with("-"):
		return &"deletion"
	return &"context"


static func _change_line_role(line: String) -> StringName:
	if line.begins_with("Created  ") or line.begins_with("已创建  "):
		return &"addition"
	if line.begins_with("Deleted  ") or line.begins_with("已删除  "):
		return &"deletion"
	if line.begins_with("Modified  ") or line.begins_with("已修改  "):
		return &"hunk"
	return &"context"


static func _diff_segments(text: String) -> Array:
	var segments: Array = []
	var lines := text.split("\n", true)
	for index in range(lines.size()):
		var segment_text := str(lines[index])
		if index < lines.size() - 1:
			segment_text += "\n"
		segments.append({"role": _diff_line_role(str(lines[index])), "text": segment_text})
	return segments


static func _change_segments(text: String) -> Array:
	var segments: Array = []
	var lines := text.split("\n", true)
	for index in range(lines.size()):
		var segment_text := str(lines[index])
		if index < lines.size() - 1:
			segment_text += "\n"
		segments.append({"role": _change_line_role(str(lines[index])), "text": segment_text})
	return segments


func _tool_segment_color(role: StringName) -> Color:
	match role:
		&"addition":
			return _editor_color("success_color", Color("7dcc91"))
		&"deletion":
			return _editor_color("error_color", Color("e18484"))
		&"hunk":
			return _editor_color("accent_color", Color("82adf5"))
		&"metadata":
			return _editor_color("warning_color", Color("d6b66f"))
		&"header":
			return _editor_color("warning_color", Color("d6b66f"))
		_:
			return _editor_color("font_color", Color("c9ced7"))


func _tool_segment_background(role: StringName) -> Color:
	if role != &"addition" and role != &"deletion" and role != &"hunk":
		return Color(0, 0, 0, 0)
	var foreground := _tool_segment_color(role)
	return Color(foreground.r, foreground.g, foreground.b, 0.14 if role != &"hunk" else 0.1)


func _render_tool_segments(body: RichTextLabel, segments: Array) -> void:
	body.text = ""
	for segment_value in segments:
		if not segment_value is Dictionary:
			continue
		var role := StringName(str(segment_value.get("role", "context")))
		var background := _tool_segment_background(role)
		body.push_color(_tool_segment_color(role))
		if background.a > 0.0:
			body.push_bgcolor(background)
		body.add_text(str(segment_value.get("text", "")))
		if background.a > 0.0:
			body.pop()
		body.pop()


func _limit_tool_detail(text: String, keep_tail: bool = false) -> String:
	if text.length() <= TOOL_OUTPUT_LIMIT:
		return text
	if keep_tail:
		var marker := _t("Output truncated; showing the last %d characters.\n\n") % TOOL_OUTPUT_LIMIT
		return "%s%s" % [marker, text.right(maxi(0, TOOL_OUTPUT_LIMIT - marker.length()))]
	var marker := _t("\n\nOutput truncated after %d characters.") % TOOL_OUTPUT_LIMIT
	return "%s%s" % [text.left(maxi(0, TOOL_OUTPUT_LIMIT - marker.length())), marker]


func _set_tool_section(section: Control, body: RichTextLabel, text: String, keep_tail: bool = false) -> void:
	var limited := _limit_tool_detail(text, keep_tail)
	var detail_kind := str(section.get_meta("detail_kind", "plain"))
	if detail_kind == "diff":
		_render_tool_segments(body, _diff_segments(limited))
	elif detail_kind == "changes":
		_render_tool_segments(body, _change_segments(limited))
	else:
		body.text = limited
	section.visible = not limited.is_empty()
	_queue_tool_detail_body_resize(body)


func _attach_tool_change_details(item_id: String, data: Dictionary) -> void:
	if not _tool_views_by_item_id.has(item_id):
		return
	var follow := _should_follow_conversation()
	var view: Dictionary = _tool_views_by_item_id[item_id]
	var changes_text := _format_changed_files(data.get("files", []))
	if changes_text.is_empty():
		changes_text = _format_editor_changes(data.get("changes", []))
	var changes_body := view.changes_body as RichTextLabel
	if not changes_text.is_empty() and changes_body.get_parsed_text().is_empty():
		_set_tool_section(view.changes_section as Control, changes_body, changes_text)
	var diff_text := str(data.get("diff", ""))
	if not diff_text.is_empty():
		_set_tool_section(view.diff_section as Control, view.diff_body as RichTextLabel, diff_text)
	_queue_scroll_to_bottom(follow)


func _append_tool_output(item_id: String, delta: String) -> void:
	if delta.is_empty() or not _tool_views_by_item_id.has(item_id):
		return
	var view: Dictionary = _tool_views_by_item_id[item_id]
	if bool(view.get("truncated", false)):
		return
	var follow := _should_follow_conversation()
	var body := view.body as RichTextLabel
	(view.output_section as Control).visible = true
	var output_length := int(view.get("output_length", 0))
	var remaining := TOOL_OUTPUT_LIMIT - output_length
	if remaining <= 0:
		body.text = _limit_tool_detail("%sx" % body.get_parsed_text())
		view["truncated"] = true
		_queue_tool_detail_body_resize(body)
		return
	if delta.length() <= remaining:
		body.add_text(delta)
		view["output_length"] = output_length + delta.length()
	else:
		var marker := _t("\n\nOutput truncated after %d characters.") % TOOL_OUTPUT_LIMIT
		var delta_limit := maxi(0, remaining - marker.length())
		body.add_text(delta.left(delta_limit))
		body.add_text(marker.left(remaining - delta_limit))
		view["output_length"] = TOOL_OUTPUT_LIMIT
		view["truncated"] = true
	_queue_tool_detail_body_resize(body)
	_queue_scroll_to_bottom(follow)


func _format_tool_output_delta(item_id: String, data: Dictionary) -> String:
	var delta := str(data.get("delta", ""))
	if not _tool_views_by_item_id.has(item_id):
		return delta
	var view: Dictionary = _tool_views_by_item_id[item_id]
	if str(view.get("name", "")) != "game_test":
		return delta
	var phase := str(data.get("phase", ""))
	if phase.is_empty():
		return delta
	var source := ""
	match phase:
		"validating":
			source = "Validating game test"
		"starting":
			source = "Starting game"
		"waiting_for_probe":
			source = "Waiting for runtime probe"
		"running_automation":
			source = "Running game automation"
		"capturing_frame":
			source = "Capturing game frame"
		"cleaning_up":
			source = "Cleaning up game test"
		"completed":
			source = "Game test completed"
		_:
			return delta
	var localized := _t(source)
	if phase == "running_automation":
		var step_count := int(data.get("step_count", 0))
		var current_step := int(data.get("current_step", 0))
		if step_count > 0:
			localized += "\n%s" % (_t("Progress: %d/%d") % [current_step, step_count])
	return "%s\n" % localized


func _complete_tool_message(item_id: String, data: Dictionary) -> void:
	if not _tool_views_by_item_id.has(item_id):
		return
	var follow := _should_follow_conversation()
	var view: Dictionary = _tool_views_by_item_id[item_id]
	var output_value = data.get("output", {})
	var output: Dictionary = output_value if output_value is Dictionary else {}
	var tool_name := str(view.get("name", ""))
	var failed := (
		output.has("error")
		or (output.has("ok") and not bool(output.get("ok", false)))
		or (tool_name.begins_with("game_automation_") and str(output.get("state", "")) == "failed")
		or (
			tool_name == "game_test"
			and str(output.get("state", "")) in [
				"failed",
				"cancelled",
				"timed_out",
				"timeout",
				"launch_failed",
				"ready_timeout",
				"automation_failed",
				"automation_timeout",
				"cleanup_failed",
				"visual_capture_failed",
			]
		)
	)
	var status := view.status as Label
	status.text = _t("Failed") if failed else _t("Done")
	status.add_theme_color_override("font_color", Color("d87979") if failed else Color("72c98a"))
	_attach_tool_change_details(item_id, output)
	var output_text := _format_tool_output(tool_name, output)
	if failed and output_text.is_empty():
		output_text = _t("Tool failed")
	if not output_text.is_empty():
		var keep_tail := str(view.get("name", "")) == "run_command"
		_set_tool_section(view.output_section as Control, view.body as RichTextLabel, output_text, keep_tail)
		view["output_length"] = mini(output_text.length(), TOOL_OUTPUT_LIMIT)
		view["truncated"] = output_text.length() > TOOL_OUTPUT_LIMIT
	if failed:
		_set_tool_details_expanded(view, true)
	_queue_scroll_to_bottom(follow)


func _show_project_context(item_id: String, data: Dictionary) -> void:
	if item_id.is_empty() or _tool_views_by_item_id.has(item_id):
		return
	var arguments := {
		"source_count": int(data.get("source_count", 0)),
		"character_count": int(data.get("character_count", 0)),
		"index_revision": str(data.get("index_revision", "")),
		"index_truncated": bool(data.get("index_truncated", false)),
		"truncated": bool(data.get("truncated", false)),
	}
	_begin_tool_message(item_id, {"name": "project_context", "arguments": arguments})
	_complete_tool_message(item_id, {"name": "project_context", "output": data})
	if not _tool_views_by_item_id.has(item_id):
		return
	var view: Dictionary = _tool_views_by_item_id[item_id]
	var details := view.get("details") as VBoxContainer
	if details == null:
		return
	var sources_value: Variant = data.get("sources", [])
	if not sources_value is Array or sources_value.is_empty():
		return
	var section := VBoxContainer.new()
	section.add_theme_constant_override("separation", 3)
	var heading := Label.new()
	heading.text = _t("Project sources")
	heading.add_theme_font_size_override("font_size", 11)
	heading.add_theme_color_override("font_color", _editor_color("font_color", Color("d6d9df")))
	section.add_child(heading)
	for source_value in sources_value:
		if not source_value is Dictionary:
			continue
		var source: Dictionary = source_value
		var source_path := str(source.get("path", ""))
		if source_path.is_empty():
			continue
		var source_line := int(source.get("line", 0))
		var button := Button.new()
		button.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
		button.flat = true
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.icon = _icon_texture("File")
		button.text = "%s%s" % [source_path, ":%d" % source_line if source_line > 0 else ""]
		button.tooltip_text = _t("Open project source")
		button.clip_text = true
		button.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		button.pressed.connect(_open_project_context_source.bind(source_path, source_line))
		section.add_child(button)
	details.add_child(section)
	details.move_child(section, mini(1, details.get_child_count() - 1))


func _open_project_context_source(source_path: String, line: int = 0) -> void:
	var normalized := source_path.strip_edges().replace("\\", "/").trim_prefix("res://").trim_prefix("./")
	if normalized.is_empty() or normalized.begins_with("/") or normalized.contains(":"):
		return
	for segment in normalized.split("/", false):
		if segment == "." or segment == "..":
			return
	var resource_path := "res://%s" % normalized
	if not FileAccess.file_exists(resource_path):
		_add_system_message(_t("Project source is no longer available: %s") % resource_path)
		return
	var extension := normalized.get_extension().to_lower()
	if extension == "tscn":
		editor_interface.open_scene_from_path(resource_path)
		return
	if extension == "godot" or not ResourceLoader.exists(resource_path):
		var source_file_system_dock := editor_interface.get_file_system_dock()
		if source_file_system_dock != null:
			source_file_system_dock.navigate_to_path(resource_path)
		return
	var resource: Resource = ResourceLoader.load(resource_path)
	var script := resource as Script
	if script != null:
		editor_interface.edit_script(script, maxi(0, line - 1), 0, true)
		return
	if resource != null:
		editor_interface.edit_resource(resource)
		return
	var file_system_dock := editor_interface.get_file_system_dock()
	if file_system_dock != null:
		file_system_dock.navigate_to_path(resource_path)


func _add_system_message(text: String) -> void:
	if text.is_empty():
		return
	var follow := _should_follow_conversation()
	var row := HBoxContainer.new()
	row.set_meta("message_kind", "system")
	row.add_theme_constant_override("separation", 6)
	row.add_child(_message_icon("Info"))
	var label := Label.new()
	label.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	label.add_theme_font_size_override("font_size", 12)
	label.add_theme_color_override("font_color", _editor_color("disabled_font_color", Color("9297a1")))
	row.add_child(label)
	_turn_timeline_parent().add_child(row)
	_queue_scroll_to_bottom(follow)


func _clear_conversation() -> void:
	_reset_message_stream()
	_reported_connection_notice_key = ""
	_discard_activity_indicator()
	_message_views_by_item_id.clear()
	_tool_views_by_item_id.clear()
	_message_items_with_deltas.clear()
	_conversation_following = true
	_scroll_settle_frames = SCROLL_SETTLE_FRAMES
	_scroll_input_settle_frames = 0
	if _conversation == null:
		return
	for child in _conversation.get_children():
		_conversation.remove_child(child)
		if child.is_inside_tree():
			child.queue_free()
		else:
			child.free()


func _begin_session_sync(restore_view: bool = true) -> void:
	if (
		_session_sync_in_flight
		or not _server_ready
		or _configured_fingerprint.is_empty()
		or _configured_fingerprint != _connection_fingerprint()
	):
		return
	_session_sync_in_flight = true
	_sessions_ready_before_sync = _sessions_ready
	_session_get_target_id = ""
	_session_get_refresh_only = false
	_session_list_restore_view = restore_view
	if restore_view:
		_sessions_ready = false
	_set_status("Loading conversations", Color("d5a15d"))
	_update_controls()
	_send_request("session.list", {})


func _populate_session_options(raw_sessions: Array) -> void:
	_session_summaries.clear()
	if _session_select == null:
		return
	_session_select.clear()
	for raw_session in raw_sessions:
		if not raw_session is Dictionary:
			continue
		var summary: Dictionary = raw_session
		var session_id := str(summary.get("session_id", "")).strip_edges()
		var title := str(summary.get("title", "")).strip_edges()
		if session_id.is_empty() or title.is_empty():
			continue
		_session_summaries.append(summary.duplicate(true))
		var display_title := _t("New conversation") if title == "New conversation" else title
		_session_select.add_item(display_title)
		var index := _session_select.item_count - 1
		_session_select.set_item_metadata(index, session_id)
		_session_select.get_popup().set_item_tooltip(index, display_title)
	_select_session_control(_session_id)


func _select_session_control(session_id: String) -> bool:
	if _session_select == null:
		return false
	for index in _session_select.item_count:
		if str(_session_select.get_item_metadata(index)) == session_id:
			_session_select.select(index)
			_session_select.tooltip_text = _session_select.get_item_text(index)
			return true
	return false


func _first_session_id() -> String:
	if _session_select == null or _session_select.item_count == 0:
		return ""
	return str(_session_select.get_item_metadata(0))


func _current_session_title() -> String:
	if _session_select == null or _session_select.selected < 0:
		return ""
	return _session_select.get_item_text(_session_select.selected)


func _on_session_selected(index: int) -> void:
	if (
		_turn_in_progress
		or _session_sync_in_flight
		or _session_select == null
		or index < 0
		or index >= _session_select.item_count
	):
		return
	var next_session_id := str(_session_select.get_item_metadata(index))
	if next_session_id.is_empty() or next_session_id == _session_id:
		return
	_sessions_ready_before_sync = _sessions_ready
	_sessions_ready = false
	_session_sync_in_flight = true
	_session_select.tooltip_text = _session_select.get_item_text(index)
	_update_controls()
	_session_get_target_id = next_session_id
	_send_request("session.get", {"session_id": next_session_id})


func _create_new_session() -> void:
	if (
		_turn_in_progress
		or _session_sync_in_flight
		or not _server_ready
		or _configured_fingerprint.is_empty()
		or _configured_fingerprint != _connection_fingerprint()
	):
		return
	_session_create_purpose = "new"
	_session_sync_in_flight = true
	_sessions_ready_before_sync = _sessions_ready
	_sessions_ready = false
	_update_controls()
	_send_request("session.create", {})


func _on_session_menu_pressed(menu_id: int) -> void:
	if _turn_in_progress or _session_sync_in_flight or _session_id.is_empty():
		return
	match menu_id:
		SESSION_MENU_RENAME:
			_rename_session_input.text = _current_session_title()
			_rename_session_dialog.popup_centered()
			_rename_session_input.select_all()
			_rename_session_input.grab_focus()
		SESSION_MENU_DELETE:
			_delete_session_dialog.popup_centered()


func _confirm_rename_session() -> void:
	if _session_id.is_empty() or _turn_in_progress or _session_sync_in_flight:
		return
	var title := _rename_session_input.text.strip_edges()
	if title.is_empty():
		return
	_session_sync_in_flight = true
	_sessions_ready_before_sync = _sessions_ready
	_update_controls()
	_send_request("session.rename", {"session_id": _session_id, "title": title})


func _confirm_delete_session() -> void:
	if _session_id.is_empty() or _turn_in_progress or _session_sync_in_flight:
		return
	_session_sync_in_flight = true
	_sessions_ready_before_sync = _sessions_ready
	_sessions_ready = false
	_update_controls()
	_send_request("session.delete", {"session_id": _session_id})


func _restore_session_sync_after_failure() -> void:
	_session_sync_in_flight = false
	_session_create_purpose = ""
	_session_list_restore_view = false
	_session_get_target_id = ""
	_session_get_refresh_only = false
	_sessions_ready = _sessions_ready_before_sync and not _session_id.is_empty()
	_sessions_ready_before_sync = false
	_select_session_control(_session_id)
	if _sessions_ready and _models_ready and not _model_sync_in_flight:
		_set_status("Ready", Color("72c98a"))
	_update_controls()


func _capture_session_diagnostics(result: Dictionary) -> void:
	var diagnostics_value = result.get("diagnostics", [])
	var diagnostics: Array = diagnostics_value if diagnostics_value is Array else []
	var fingerprint := JSON.stringify(diagnostics)
	_pending_session_diagnostics.clear()
	if fingerprint == _session_diagnostic_fingerprint:
		return
	_session_diagnostic_fingerprint = fingerprint
	for index in mini(diagnostics.size(), 3):
		var diagnostic_value = diagnostics[index]
		if not diagnostic_value is Dictionary:
			continue
		var diagnostic: Dictionary = diagnostic_value
		var filename := str(diagnostic.get("filename", "conversation.json"))
		var reason := _session_diagnostic_reason(str(diagnostic.get("code", "corrupt")))
		_pending_session_diagnostics.append(
			_t("Saved conversation %s could not be loaded: %s") % [filename, reason]
		)
	if diagnostics.size() > 3:
		_pending_session_diagnostics.append(
			_t("%d additional saved conversations could not be loaded.") % (diagnostics.size() - 3)
		)


func _flush_session_diagnostics() -> void:
	for diagnostic in _pending_session_diagnostics:
		_append_system(diagnostic)
	_pending_session_diagnostics.clear()


func _session_diagnostic_reason(code: String) -> String:
	match code:
		"too_large":
			return _t("Snapshot is too large")
		"unreadable":
			return _t("Snapshot is unreadable")
		"recovery_write_failed":
			return _t("Interrupted-turn recovery could not be saved")
		_:
			return _t("Snapshot is corrupt")


func _render_session_snapshot(snapshot: Dictionary, reset_page: bool = true) -> void:
	if reset_page:
		_session_snapshot = snapshot.duplicate(true)
		_session_history_page = 0
	_clear_conversation()
	var turns_value = snapshot.get("turns", [])
	if not turns_value is Array:
		return
	var turns: Array = turns_value
	var pages := _paginate_session_turns(turns)
	if pages.is_empty():
		_queue_scroll_to_bottom(true)
		return
	_session_history_page = clampi(_session_history_page, 0, pages.size() - 1)
	var turns_to_render: Array = pages[_session_history_page]
	for turn_value in turns_to_render:
		if not turn_value is Dictionary:
			continue
		var turn: Dictionary = turn_value
		var prompt := str(turn.get("prompt", ""))
		var turn_attachments_value: Variant = turn.get("attachments", [])
		var turn_attachments: Array = (
			turn_attachments_value
			if turn_attachments_value is Array
			else []
		)
		if not prompt.is_empty() or not turn_attachments.is_empty():
			_add_user_message(prompt, turn_attachments)
		_begin_activity_indicator()
		_bind_activity_turn(str(turn.get("turn_id", "")))
		var usage_value = turn.get("usage", {})
		var activity_metrics: Dictionary = usage_value.duplicate(true) if usage_value is Dictionary else {}
		var context_value = turn.get("context", {})
		if context_value is Dictionary:
			activity_metrics.merge(context_value, true)
		_update_activity_usage(activity_metrics)
		var entries_value = turn.get("entries", [])
		if entries_value is Array:
			for entry_value in entries_value:
				if not entry_value is Dictionary:
					continue
				var entry: Dictionary = entry_value
				var item_id := str(entry.get("item_id", "history_item"))
				match str(entry.get("kind", "")):
					"context":
						var context_value_entry: Variant = entry.get("data", {})
						if context_value_entry is Dictionary:
							_show_project_context(item_id, context_value_entry)
					"assistant":
						var reasoning := str(entry.get("reasoning", ""))
						if not reasoning.is_empty():
							_append_reasoning_text(item_id, reasoning)
						_append_assistant_text(item_id, str(entry.get("text", "")))
					"tool":
						var arguments_value = entry.get("arguments", {})
						var arguments: Dictionary = arguments_value if arguments_value is Dictionary else {}
						var name := str(entry.get("name", "tool"))
						_begin_tool_message(item_id, {"name": name, "arguments": arguments})
						var output_value = entry.get("output", {})
						var output: Dictionary = (
							output_value
							if output_value is Dictionary
							else {"ok": true, "value": output_value}
						)
						_complete_tool_message(item_id, {"name": name, "output": output})
		var status := str(turn.get("status", "completed"))
		if status == "failed" and not str(turn.get("error", "")).is_empty():
			var persisted_error := {
				"code": str(turn.get("error_code", "")),
				"message": str(turn.get("error", "")),
			}
			var persisted_error_status := int(turn.get("error_status", 0))
			if persisted_error_status > 0:
				persisted_error["data"] = {"status": persisted_error_status}
			if _is_provider_billing_error(persisted_error):
				_add_system_message(_provider_billing_message(persisted_error))
			elif _is_provider_auth_error(persisted_error):
				_add_system_message(_provider_auth_message(persisted_error))
			else:
				_add_system_message(str(turn.get("error", "")))
		var activity_result := "Failed" if status == "failed" else ("Stopped" if status == "interrupted" else "Worked")
		_finish_activity_indicator(activity_result, maxi(0, int(turn.get("duration_ms", 0))))
	if pages.size() > 1:
		_add_session_history_pager(pages.size())
	_queue_scroll_to_bottom(true)


static func _paginate_session_turns(turns: Array) -> Array:
	var pages: Array = []
	var page: Array = []
	var page_entries := 0
	for turn_index in range(turns.size() - 1, -1, -1):
		var candidate_value = turns[turn_index]
		if not candidate_value is Dictionary:
			continue
		var candidate: Dictionary = candidate_value
		var entries_value = candidate.get("entries", [])
		var entry_count: int = entries_value.size() if entries_value is Array else 0
		if (
			not page.is_empty()
			and (
				page.size() >= SESSION_RENDER_TURN_LIMIT
				or page_entries + entry_count > SESSION_RENDER_ENTRY_LIMIT
			)
		):
			pages.append(page)
			page = []
			page_entries = 0
		page.push_front(candidate)
		page_entries += entry_count
	if not page.is_empty():
		pages.append(page)
	return pages


func _add_session_history_pager(page_count: int) -> void:
	var row := HBoxContainer.new()
	row.set_meta("message_kind", "history_pager")
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	row.add_theme_constant_override("separation", 8)
	var earlier := Button.new()
	earlier.text = _t("Earlier")
	earlier.disabled = _session_history_page >= page_count - 1
	earlier.pressed.connect(_show_session_history_page.bind(1))
	row.add_child(earlier)
	var page_label := Label.new()
	page_label.text = _t("History page %d of %d") % [_session_history_page + 1, page_count]
	page_label.add_theme_color_override("font_color", _editor_color("disabled_font_color", Color("9297a1")))
	row.add_child(page_label)
	var newer := Button.new()
	newer.text = _t("Newer")
	newer.disabled = _session_history_page <= 0
	newer.pressed.connect(_show_session_history_page.bind(-1))
	row.add_child(newer)
	_conversation.add_child(row)


func _show_session_history_page(offset: int) -> void:
	if _session_snapshot.is_empty():
		return
	var turns_value = _session_snapshot.get("turns", [])
	if not turns_value is Array:
		return
	var turns: Array = turns_value
	var pages := _paginate_session_turns(turns)
	if pages.is_empty():
		return
	var next_page := clampi(_session_history_page + offset, 0, pages.size() - 1)
	if next_page == _session_history_page:
		return
	_session_history_page = next_page
	_render_session_snapshot(_session_snapshot, false)


func _return_to_latest_session_history() -> void:
	if _session_history_page <= 0 or _session_snapshot.is_empty():
		return
	_session_history_page = 0
	_render_session_snapshot(_session_snapshot, false)


func _invalidate_session_snapshot_cache() -> void:
	_session_snapshot.clear()
	_session_history_page = 0
	if _conversation == null:
		return
	for child in _conversation.get_children():
		if str(child.get_meta("message_kind", "")) != "history_pager":
			continue
		_conversation.remove_child(child)
		if child.is_inside_tree():
			child.queue_free()
		else:
			child.free()


func _should_follow_conversation() -> bool:
	return _conversation_following


func _queue_scroll_to_bottom(should_scroll: bool) -> void:
	if not should_scroll:
		return
	_conversation_following = true
	_scroll_settle_frames = SCROLL_SETTLE_FRAMES
	_scroll_input_settle_frames = 0
	if _conversation_scroll != null and _conversation_scroll.is_inside_tree():
		call_deferred("_scroll_conversation_to_bottom")


func _scroll_conversation_to_bottom() -> void:
	if not _conversation_following or _conversation_scroll == null or not _conversation_scroll.is_inside_tree():
		return
	var scroll_bar := _conversation_scroll.get_v_scroll_bar()
	var target := maxf(0.0, scroll_bar.max_value - scroll_bar.page)
	_conversation_scroll.scroll_vertical = int(ceil(target))


func _settle_conversation_scroll() -> void:
	if _scroll_settle_frames <= 0 or not _conversation_following:
		return
	if _conversation_scroll == null or not _conversation_scroll.is_inside_tree():
		return
	_scroll_conversation_to_bottom()
	_scroll_settle_frames -= 1


func _on_conversation_layout_changed() -> void:
	if _conversation_following:
		_scroll_settle_frames = SCROLL_SETTLE_FRAMES


func _on_conversation_scroll_input(event: InputEvent, from_scrollbar: bool = false) -> void:
	var mouse_button := event as InputEventMouseButton
	if mouse_button != null:
		if mouse_button.button_index == MOUSE_BUTTON_WHEEL_UP and mouse_button.pressed:
			_pause_conversation_following()
			call_deferred("_resume_conversation_following_if_at_bottom", 0.5)
			return
		if mouse_button.button_index == MOUSE_BUTTON_WHEEL_DOWN and mouse_button.pressed:
			_pause_conversation_following()
			call_deferred("_resume_conversation_following_if_at_bottom", SCROLL_BOTTOM_THRESHOLD)
			return
		if from_scrollbar and mouse_button.button_index == MOUSE_BUTTON_LEFT:
			_pause_conversation_following()
			if not mouse_button.pressed:
				call_deferred("_resume_conversation_following_if_at_bottom", SCROLL_BOTTOM_THRESHOLD)
			return
	if event is InputEventPanGesture or event is InputEventScreenDrag:
		_pause_conversation_following()
		_scroll_input_settle_frames = SCROLL_INPUT_SETTLE_FRAMES
		return
	var key_event := event as InputEventKey
	if key_event == null or not key_event.pressed:
		return
	if key_event.keycode in [KEY_UP, KEY_PAGEUP, KEY_HOME]:
		_pause_conversation_following()
		call_deferred("_resume_conversation_following_if_at_bottom", 0.5)
	elif key_event.keycode in [KEY_DOWN, KEY_PAGEDOWN, KEY_END]:
		_pause_conversation_following()
		call_deferred("_resume_conversation_following_if_at_bottom", SCROLL_BOTTOM_THRESHOLD)


func _on_conversation_touch_scroll_started() -> void:
	_pause_conversation_following()
	_scroll_input_settle_frames = 0


func _on_conversation_touch_scroll_ended() -> void:
	_resume_conversation_following_if_at_bottom(SCROLL_BOTTOM_THRESHOLD)


func _settle_conversation_scroll_input() -> void:
	if _scroll_input_settle_frames <= 0:
		return
	_scroll_input_settle_frames -= 1
	if _scroll_input_settle_frames == 0:
		_resume_conversation_following_if_at_bottom(SCROLL_BOTTOM_THRESHOLD)


func _pause_conversation_following() -> void:
	_conversation_following = false
	_scroll_settle_frames = 0
	_scroll_input_settle_frames = 0


func _resume_conversation_following_if_at_bottom(threshold: float = SCROLL_BOTTOM_THRESHOLD) -> void:
	if _conversation_scroll == null or not _conversation_scroll.is_inside_tree():
		return
	var scroll_bar := _conversation_scroll.get_v_scroll_bar()
	var distance_from_bottom := maxf(0.0, scroll_bar.max_value - scroll_bar.page - scroll_bar.value)
	if distance_from_bottom <= threshold:
		_queue_scroll_to_bottom(true)


func _update_controls() -> void:
	var visual_import_busy := _pending_visual_imports > 0
	var connection_busy := (
		_shutting_down
		or _turn_in_progress
		or _model_sync_in_flight
		or _provider_sync_in_flight
		or _session_sync_in_flight
		or visual_import_busy
	)
	if _send_button != null:
		_send_button.visible = not _turn_in_progress
		_send_button.disabled = (
			connection_busy
			or _plugin_reload_required
			or not _server_ready
			or not _models_ready
			or not _sessions_ready
			or _prompt == null
			or (
				_prompt.text.strip_edges().is_empty()
				and _pending_attachments.is_empty()
			)
			or (
				not _pending_attachments.is_empty()
				and _selected_model_image_capability() == IMAGE_CAPABILITY_UNSUPPORTED
			)
		)
	if _stop_button != null:
		_stop_button.visible = _turn_in_progress
		_stop_button.disabled = not _turn_in_progress
	if _settings_button != null:
		_settings_button.disabled = connection_busy
	if _clear_button != null:
		_clear_button.disabled = (
			connection_busy
			or not _server_ready
			or _configured_fingerprint.is_empty()
			or _configured_fingerprint != _connection_fingerprint()
		)
	if _session_select != null:
		_session_select.disabled = connection_busy or _session_select.item_count == 0
	if _session_menu != null:
		_session_menu.disabled = connection_busy or _session_id.is_empty()
	if _refresh_models_button != null:
		_refresh_models_button.disabled = connection_busy or not _server_ready or not _provider_config_is_complete(
			_provider_id, _provider_config(_provider_id)
		)
	if _model_select != null:
		_model_select.disabled = _model_sync_in_flight or visual_import_busy or not _models_ready
	if _reasoning_select != null:
		_reasoning_select.disabled = (
			_model_sync_in_flight
			or visual_import_busy
			or not _models_ready
			or not _reasoning_select.visible
		)
	if _attachment_menu != null:
		var image_capability := _selected_model_image_capability()
		_attachment_menu.disabled = (
			connection_busy
			or not _models_ready
			or (
				_pending_attachments.size() + _pending_visual_imports
				>= AttachmentStore.MAX_ATTACHMENTS_PER_TURN
			)
			or image_capability == IMAGE_CAPABILITY_UNSUPPORTED
		)
		_attachment_menu.tooltip_text = (
			_t("The selected model does not support image input.")
			if image_capability == IMAGE_CAPABILITY_UNSUPPORTED
			else _t("Add visual attachment")
		)
	if _composer_drop_target != null:
		_composer_drop_target.drop_enabled = (
			not connection_busy
			and _models_ready
			and not _plugin_reload_required
			and (
				_pending_attachments.size() + _pending_visual_imports
				< AttachmentStore.MAX_ATTACHMENTS_PER_TURN
			)
			and _selected_model_image_capability() != IMAGE_CAPABILITY_UNSUPPORTED
		)
	if _attachment_list != null:
		for child in _attachment_list.get_children():
			var annotation_button_value: Variant = child.get_meta("annotation_button", null)
			if annotation_button_value is BaseButton:
				(annotation_button_value as BaseButton).disabled = connection_busy
	if _approval_mode_select != null:
		_approval_mode_select.disabled = _turn_in_progress
	if _settings_dialog != null:
		_settings_dialog.get_ok_button().disabled = connection_busy
		if _settings_provider_select != null:
			_settings_provider_select.disabled = connection_busy
		for raw_control in _settings_config_controls.values():
			var control := raw_control as Control
			if control is LineEdit:
				(control as LineEdit).editable = not connection_busy
			elif control is OptionButton:
				(control as OptionButton).disabled = connection_busy
		if _settings_base_url != null:
			_settings_base_url.editable = not connection_busy
		if _settings_api_key != null:
			_settings_api_key.editable = not connection_busy
		_remember_api_key.disabled = connection_busy
		_auto_approve_edits.disabled = connection_busy
		_runtime_automation.disabled = connection_busy


func _open_settings() -> void:
	if _settings_dialog == null or _turn_in_progress or _model_sync_in_flight or _provider_sync_in_flight:
		return
	_settings_provider_drafts = _provider_configs.duplicate(true)
	_settings_remember_drafts = _provider_remember_secrets.duplicate(true)
	_settings_provider_id = _provider_id
	_populate_provider_options(_settings_provider_id)
	_rebuild_settings_provider_fields(
		_settings_provider_id,
		_settings_provider_draft(_settings_provider_id)
	)
	_sync_approval_controls()
	_runtime_automation.button_pressed = _runtime_automation_enabled
	_settings_dialog.popup_centered()


func _apply_settings() -> void:
	if (
		_turn_in_progress
		or _model_sync_in_flight
		or _provider_sync_in_flight
		or not _image_generation_requests.is_empty()
		or not _image_context_captures.is_empty()
	):
		_append_system("Wait for the current task before changing connection settings.")
		call_deferred("_reopen_settings")
		return
	_store_settings_provider_draft()
	var next_provider := _settings_provider_id
	var next_config := _settings_provider_draft(next_provider)
	var config_error := _provider_config_error(next_provider, next_config)
	if not config_error.is_empty():
		_append_system(config_error)
		call_deferred("_reopen_settings")
		return
	var previous_fingerprint := _connection_fingerprint()
	_provider_id = next_provider
	_provider_configs = _settings_provider_drafts.duplicate(true)
	_provider_remember_secrets = _settings_remember_drafts.duplicate(true)
	_provider_configs[_provider_id] = next_config.duplicate(true)
	_provider_remember_secrets[_provider_id] = _remember_api_key.button_pressed
	_sync_legacy_connection_aliases()
	_set_auto_approve_edits_enabled(_auto_approve_edits.button_pressed)
	_runtime_automation_enabled = _runtime_automation.button_pressed
	if _editor_bridge != null:
		_editor_bridge.set_runtime_automation_enabled(_runtime_automation_enabled)
	_persist_connection_settings()
	var connection_changed := _connection_fingerprint() != previous_fingerprint
	if connection_changed:
		_models_ready = false
		_model_capabilities.clear()
	if connection_changed or not _models_ready:
		_reported_connection_notice_key = ""
		_begin_model_sync()
	else:
		_update_controls()


func _load_persisted_connection_settings(settings_prefix: String = "") -> void:
	if editor_interface == null:
		return
	var settings := editor_interface.get_editor_settings()
	_base_url_value = DEFAULT_BASE_URL
	_api_key_value = ""
	var prefix := settings_prefix if not settings_prefix.is_empty() else _connection_settings_prefix()
	var selected_provider_setting := "%s/%s" % [prefix, SETTING_SELECTED_PROVIDER]
	_provider_id = DEFAULT_PROVIDER
	if settings.has_setting(selected_provider_setting):
		var saved_provider := str(settings.get_setting(selected_provider_setting)).strip_edges()
		if not saved_provider.is_empty():
			_provider_id = saved_provider
	var base_url_setting := "%s/%s" % [prefix, SETTING_BASE_URL]
	var api_key_setting := "%s/%s" % [prefix, SETTING_API_KEY]
	var remember_setting := "%s/%s" % [prefix, SETTING_REMEMBER_API_KEY]
	var saved_base_url := DEFAULT_BASE_URL
	if settings.has_setting(base_url_setting):
		saved_base_url = _normalize_base_url(str(settings.get_setting(base_url_setting)))
	if _is_valid_saved_base_url(saved_base_url):
		_base_url_value = saved_base_url
	_remember_api_key_enabled = true
	if settings.has_setting(remember_setting):
		_remember_api_key_enabled = bool(settings.get_setting(remember_setting))
	if _remember_api_key_enabled and settings.has_setting(api_key_setting):
		_api_key_value = str(settings.get_setting(api_key_setting))
	elif settings.has_setting(api_key_setting):
		settings.erase(api_key_setting)
	var auto_approve_setting := "%s/%s" % [prefix, SETTING_AUTO_APPROVE_EDITS]
	_auto_approve_edits_enabled = false
	if settings.has_setting(auto_approve_setting):
		_auto_approve_edits_enabled = bool(settings.get_setting(auto_approve_setting))
	var runtime_automation_setting := "%s/%s" % [prefix, SETTING_RUNTIME_AUTOMATION_ENABLED]
	_runtime_automation_enabled = false
	if settings.has_setting(runtime_automation_setting):
		_runtime_automation_enabled = bool(settings.get_setting(runtime_automation_setting))
	var selected_session_setting := "%s/%s" % [prefix, SETTING_SELECTED_SESSION_ID]
	if settings.has_setting(selected_session_setting):
		_session_id = str(settings.get_setting(selected_session_setting)).strip_edges()
	var legacy_config := {
		"base_url": _base_url_value,
		"api_key": _api_key_value,
	}
	_provider_configs[DEFAULT_PROVIDER] = legacy_config
	_provider_remember_secrets[DEFAULT_PROVIDER] = _remember_api_key_enabled
	_load_provider_settings(settings, prefix, DEFAULT_PROVIDER)
	if _provider_id != DEFAULT_PROVIDER:
		_load_provider_settings(settings, prefix, _provider_id)
	_sync_legacy_connection_aliases()


func _persist_connection_settings(settings_prefix: String = "") -> void:
	if editor_interface == null:
		return
	var settings := editor_interface.get_editor_settings()
	var prefix := settings_prefix if not settings_prefix.is_empty() else _connection_settings_prefix()
	settings.set_setting("%s/%s" % [prefix, SETTING_SCHEMA_VERSION], SETTINGS_SCHEMA_VERSION)
	settings.set_setting("%s/%s" % [prefix, SETTING_SELECTED_PROVIDER], _provider_id)
	for raw_provider_id in _provider_configs:
		var provider_id := str(raw_provider_id)
		var provider_prefix := _provider_settings_prefix(prefix, provider_id)
		var persisted_config := _provider_config(provider_id)
		var remember_secrets := bool(_provider_remember_secrets.get(provider_id, true))
		if not remember_secrets:
			for secret_key in _provider_secret_keys(provider_id):
				persisted_config.erase(secret_key)
		settings.set_setting("%s/config" % provider_prefix, persisted_config)
		settings.set_setting("%s/remember_secrets" % provider_prefix, remember_secrets)
	var api_key_setting := "%s/%s" % [prefix, SETTING_API_KEY]
	var remember_setting := "%s/%s" % [prefix, SETTING_REMEMBER_API_KEY]
	settings.set_setting("%s/%s" % [prefix, SETTING_BASE_URL], _base_url_value)
	settings.set_setting("%s/%s" % [prefix, SETTING_AUTO_APPROVE_EDITS], _auto_approve_edits_enabled)
	settings.set_setting("%s/%s" % [prefix, SETTING_RUNTIME_AUTOMATION_ENABLED], _runtime_automation_enabled)
	settings.set_setting("%s/%s" % [prefix, SETTING_SELECTED_SESSION_ID], _session_id)
	if _remember_api_key_enabled:
		settings.set_setting(api_key_setting, _api_key_value)
		settings.set_setting(remember_setting, true)
	else:
		if settings.has_setting(api_key_setting):
			settings.erase(api_key_setting)
		settings.set_setting(remember_setting, false)


func _persist_selected_session() -> void:
	if editor_interface == null:
		return
	var settings := editor_interface.get_editor_settings()
	settings.set_setting(
		"%s/%s" % [_connection_settings_prefix(), SETTING_SELECTED_SESSION_ID],
		_session_id
	)


func _persist_auto_approve_setting(settings_prefix: String = "") -> void:
	if editor_interface == null:
		return
	var settings := editor_interface.get_editor_settings()
	var prefix := settings_prefix if not settings_prefix.is_empty() else _connection_settings_prefix()
	settings.set_setting(
		"%s/%s" % [prefix, SETTING_AUTO_APPROVE_EDITS],
		_auto_approve_edits_enabled
	)


func _load_provider_settings(settings, prefix: String, provider_id: String) -> void:
	var provider_prefix := _provider_settings_prefix(prefix, provider_id)
	var config_setting := "%s/config" % provider_prefix
	var remember_setting := "%s/remember_secrets" % provider_prefix
	if settings.has_setting(config_setting):
		var saved_config = settings.get_setting(config_setting)
		if saved_config is Dictionary:
			_provider_configs[provider_id] = (saved_config as Dictionary).duplicate(true)
	if settings.has_setting(remember_setting):
		_provider_remember_secrets[provider_id] = bool(settings.get_setting(remember_setting))


func _provider_settings_prefix(prefix: String, provider_id: String) -> String:
	return "%s/providers/%s" % [prefix, _sha256_text(provider_id)]


func _ensure_builtin_provider_descriptor() -> void:
	if not _provider_descriptors.has(DEFAULT_PROVIDER):
		_provider_descriptors[DEFAULT_PROVIDER] = {
			"id": DEFAULT_PROVIDER,
			"display_name": "OpenAI compatible",
			"default_model": DEFAULT_MODEL,
			"config_fields": [
				{
					"key": "base_url",
					"label": "Base URL",
					"type": "url",
					"required": true,
					"default_value": DEFAULT_BASE_URL,
				},
				{
					"key": "api_key",
					"label": "API key",
					"type": "secret",
					"required": true,
				},
				{
					"key": "api_mode",
					"label": "API mode",
					"type": "select",
					"required": false,
					"default_value": "auto",
					"options": [
						{"value": "auto", "label": "Auto"},
						{"value": "responses", "label": "Responses"},
						{"value": "chat_completions", "label": "Chat Completions"},
					],
				},
			],
		}
	if not _provider_configs.has(DEFAULT_PROVIDER):
		_provider_configs[DEFAULT_PROVIDER] = {
			"base_url": _base_url_value,
			"api_key": _api_key_value,
		}
	if not _provider_remember_secrets.has(DEFAULT_PROVIDER):
		_provider_remember_secrets[DEFAULT_PROVIDER] = _remember_api_key_enabled
	_strip_unremembered_secrets(DEFAULT_PROVIDER)


func _provider_fields(provider_id: String) -> Array:
	var raw_descriptor = _provider_descriptors.get(provider_id, {})
	if not raw_descriptor is Dictionary:
		return []
	var raw_fields = (raw_descriptor as Dictionary).get("config_fields", [])
	return raw_fields if raw_fields is Array else []


func _provider_config(provider_id: String) -> Dictionary:
	var raw_config = _provider_configs.get(provider_id, {})
	var config: Dictionary = (raw_config as Dictionary).duplicate(true) if raw_config is Dictionary else {}
	for raw_field in _provider_fields(provider_id):
		if not raw_field is Dictionary:
			continue
		var field: Dictionary = raw_field
		var key := str(field.get("key", ""))
		if key.is_empty() or config.has(key) or not field.has("default_value"):
			continue
		config[key] = str(field.get("default_value", ""))
	if provider_id == DEFAULT_PROVIDER:
		if not config.has("base_url"):
			config["base_url"] = _base_url_value
		if not config.has("api_key"):
			config["api_key"] = _api_key_value
	return config


func _settings_provider_draft(provider_id: String) -> Dictionary:
	var raw_config = _settings_provider_drafts.get(provider_id, null)
	if raw_config is Dictionary:
		return (raw_config as Dictionary).duplicate(true)
	return _provider_config(provider_id)


func _populate_provider_options(selected_provider: String) -> void:
	if _settings_provider_select == null:
		return
	_settings_provider_select.clear()
	var provider_ids: Array = _provider_descriptors.keys()
	provider_ids.sort()
	if provider_ids.has(DEFAULT_PROVIDER):
		provider_ids.erase(DEFAULT_PROVIDER)
		provider_ids.push_front(DEFAULT_PROVIDER)
	var selected_index := 0
	for raw_provider_id in provider_ids:
		var provider_id := str(raw_provider_id)
		var descriptor: Dictionary = _provider_descriptors.get(provider_id, {})
		var display_name := str(descriptor.get("display_name", provider_id))
		_settings_provider_select.add_item(_t(display_name))
		var index := _settings_provider_select.item_count - 1
		_settings_provider_select.set_item_metadata(index, provider_id)
		_settings_provider_select.get_popup().set_item_tooltip(index, provider_id)
		if provider_id == selected_provider:
			selected_index = index
	if _settings_provider_select.item_count > 0:
		_settings_provider_select.select(selected_index)


func _on_settings_provider_selected(index: int) -> void:
	if _settings_provider_select == null or index < 0 or index >= _settings_provider_select.item_count:
		return
	_store_settings_provider_draft()
	_settings_provider_id = str(_settings_provider_select.get_item_metadata(index))
	_rebuild_settings_provider_fields(
		_settings_provider_id,
		_settings_provider_draft(_settings_provider_id)
	)


func _store_settings_provider_draft() -> void:
	if _settings_provider_id.is_empty() or _settings_config_controls.is_empty():
		return
	_settings_provider_drafts[_settings_provider_id] = _read_settings_provider_config()
	if _remember_api_key != null:
		_settings_remember_drafts[_settings_provider_id] = _remember_api_key.button_pressed


func _read_settings_provider_config() -> Dictionary:
	var config := _settings_provider_draft(_settings_provider_id)
	for raw_key in _settings_config_controls:
		var key := str(raw_key)
		var control := _settings_config_controls[raw_key] as Control
		if control is LineEdit:
			var value := (control as LineEdit).text.strip_edges()
			if _provider_field_type(_settings_provider_id, key) == "url":
				value = _normalize_base_url(value)
			config[key] = value
		elif control is OptionButton:
			var option := control as OptionButton
			if option.selected >= 0:
				config[key] = str(option.get_item_metadata(option.selected))
	return config


func _rebuild_settings_provider_fields(provider_id: String, config: Dictionary) -> void:
	if _settings_dynamic_fields == null:
		return
	for child in _settings_dynamic_fields.get_children():
		_settings_dynamic_fields.remove_child(child)
		child.free()
	_settings_config_controls.clear()
	var use_legacy_fields := provider_id == DEFAULT_PROVIDER
	_settings_legacy_fields.visible = use_legacy_fields
	if use_legacy_fields:
		_settings_base_url.text = str(config.get("base_url", DEFAULT_BASE_URL))
		_settings_api_key.text = str(config.get("api_key", ""))
		_settings_config_controls["base_url"] = _settings_base_url
		_settings_config_controls["api_key"] = _settings_api_key
	for raw_field in _provider_fields(provider_id):
		if not raw_field is Dictionary:
			continue
		var field: Dictionary = raw_field
		var key := str(field.get("key", "")).strip_edges()
		var field_type := str(field.get("type", "text"))
		if key.is_empty() or (use_legacy_fields and (key == "base_url" or key == "api_key")):
			continue
		var label_text := _t(str(field.get("label", key)))
		if bool(field.get("required", false)):
			label_text += " *"
		var field_label := _label(label_text)
		var description := _t(str(field.get("description", "")))
		field_label.tooltip_text = description
		_settings_dynamic_fields.add_child(field_label)
		var field_control: Control
		if field_type == "select":
			var option := OptionButton.new()
			option.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
			option.get_popup().auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
			var selected_value := str(config.get(key, field.get("default_value", "")))
			var selected_index := 0
			var raw_options = field.get("options", [])
			if raw_options is Array:
				for raw_option in raw_options:
					if not raw_option is Dictionary:
						continue
					var option_entry: Dictionary = raw_option
					var value := str(option_entry.get("value", ""))
					option.add_item(_t(str(option_entry.get("label", value))))
					var option_index := option.item_count - 1
					option.set_item_metadata(option_index, value)
					if value == selected_value:
						selected_index = option_index
			if option.item_count > 0:
				option.select(selected_index)
			field_control = option
		else:
			var line_edit := LineEdit.new()
			line_edit.auto_translate_mode = Node.AUTO_TRANSLATE_MODE_DISABLED
			line_edit.secret = field_type == "secret"
			line_edit.text = str(config.get(key, field.get("default_value", "")))
			field_control = line_edit
		field_control.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		field_control.tooltip_text = description
		_settings_dynamic_fields.add_child(field_control)
		_settings_config_controls[key] = field_control
	var has_secrets := not _provider_secret_keys(provider_id).is_empty()
	_remember_api_key.visible = has_secrets
	_remember_api_key.button_pressed = bool(
		_settings_remember_drafts.get(
			provider_id,
			_provider_remember_secrets.get(provider_id, true)
		)
	)


func _provider_field_type(provider_id: String, field_key: String) -> String:
	for raw_field in _provider_fields(provider_id):
		if raw_field is Dictionary and str((raw_field as Dictionary).get("key", "")) == field_key:
			return str((raw_field as Dictionary).get("type", "text"))
	return "text"


func _provider_secret_keys(provider_id: String) -> Array[String]:
	var keys: Array[String] = []
	for raw_field in _provider_fields(provider_id):
		if not raw_field is Dictionary:
			continue
		var field: Dictionary = raw_field
		if str(field.get("type", "")) == "secret":
			var key := str(field.get("key", ""))
			if not key.is_empty():
				keys.append(key)
	return keys


func _strip_unremembered_secrets(provider_id: String) -> void:
	if bool(_provider_remember_secrets.get(provider_id, true)):
		return
	var config := _provider_config(provider_id)
	for secret_key in _provider_secret_keys(provider_id):
		config.erase(secret_key)
	_provider_configs[provider_id] = config


func _provider_config_error(provider_id: String, config: Dictionary) -> String:
	for raw_field in _provider_fields(provider_id):
		if not raw_field is Dictionary:
			continue
		var field: Dictionary = raw_field
		var key := str(field.get("key", ""))
		var label_text := _t(str(field.get("label", key)))
		var value := str(config.get(key, "")).strip_edges()
		if bool(field.get("required", false)) and value.is_empty():
			return _t("%s is required.") % label_text
		if str(field.get("type", "")) != "url" or value.is_empty():
			continue
		var lower_value := value.to_lower()
		if not (lower_value.begins_with("https://") or lower_value.begins_with("http://")):
			return _t("%s must start with https:// or http://.") % label_text
		if _base_url_has_credentials(value):
			return _t("%s must not contain embedded credentials.") % label_text
		if value.contains("?") or value.contains("#"):
			return _t("%s must not contain a query or fragment.") % label_text
		var insecure_http_enabled := str(config.get("allow_insecure_http", "false")) == "true"
		if (
			lower_value.begins_with("http://")
			and not _is_loopback_http_url(lower_value)
			and not insecure_http_enabled
		):
			return _t("Remote URLs must use HTTPS. HTTP is allowed only for loopback addresses.")
	return ""


func _provider_config_is_complete(provider_id: String, config: Dictionary) -> bool:
	return not provider_id.is_empty() and _provider_descriptors.has(provider_id) and _provider_config_error(
		provider_id, config
	).is_empty()


func _sync_legacy_connection_aliases() -> void:
	var fallback_config := _provider_config(DEFAULT_PROVIDER)
	_base_url_value = _normalize_base_url(str(fallback_config.get("base_url", DEFAULT_BASE_URL)))
	_api_key_value = str(fallback_config.get("api_key", ""))
	_remember_api_key_enabled = bool(_provider_remember_secrets.get(DEFAULT_PROVIDER, true))
	_provider_configs[DEFAULT_PROVIDER] = fallback_config


func _connection_settings_prefix() -> String:
	var normalized_path := _normalize_workspace_identity(_workspace_path, OS.get_name())
	return "%s/%s" % [SETTINGS_ROOT, _sha256_text(normalized_path)]


static func _normalize_workspace_identity(workspace_path: String, platform_name: String) -> String:
	var normalized_path := workspace_path.replace("\\", "/").trim_suffix("/")
	if platform_name == "Windows":
		normalized_path = normalized_path.to_lower()
	return normalized_path


func _is_valid_saved_base_url(value: String) -> bool:
	var lower_value := value.to_lower()
	if _base_url_has_credentials(value) or value.contains("?") or value.contains("#"):
		return false
	if lower_value.begins_with("https://"):
		return true
	return lower_value.begins_with("http://") and _is_loopback_http_url(lower_value)


func _reopen_settings() -> void:
	if _settings_dialog != null:
		_settings_dialog.popup_centered()


func _begin_provider_sync() -> void:
	if _provider_sync_in_flight or not _server_ready:
		return
	_provider_sync_in_flight = true
	_providers_ready = false
	_models_ready = false
	_set_status("Syncing providers", Color("d5a15d"))
	_update_controls()
	_send_request("providers.list", {})


func _populate_providers(raw_providers: Array) -> bool:
	var descriptors := {}
	for raw_provider in raw_providers:
		if not raw_provider is Dictionary:
			continue
		var provider: Dictionary = raw_provider
		var provider_id := str(provider.get("id", "")).strip_edges()
		if provider_id.is_empty() or descriptors.has(provider_id):
			continue
		var default_model := str(provider.get("default_model", "")).strip_edges()
		if default_model.is_empty():
			continue
		var config_fields: Array = []
		var raw_fields = provider.get("config_fields", [])
		if raw_fields is Array:
			for raw_field in raw_fields:
				var field := _sanitize_provider_field(raw_field)
				if not field.is_empty():
					config_fields.append(field)
		var descriptor := {
			"id": provider_id,
			"display_name": str(provider.get("display_name", provider_id)),
			"default_model": default_model,
			"config_fields": config_fields,
		}
		descriptors[provider_id] = descriptor
	if descriptors.is_empty():
		return false
	_provider_descriptors = descriptors
	if editor_interface != null:
		var settings := editor_interface.get_editor_settings()
		var settings_prefix := _connection_settings_prefix()
		for raw_provider_id in _provider_descriptors:
			_load_provider_settings(settings, settings_prefix, str(raw_provider_id))
	for raw_provider_id in _provider_descriptors:
		_strip_unremembered_secrets(str(raw_provider_id))
	if not _provider_descriptors.has(_provider_id):
		_provider_id = DEFAULT_PROVIDER if _provider_descriptors.has(DEFAULT_PROVIDER) else str(
			_provider_descriptors.keys()[0]
		)
	_settings_provider_id = _provider_id
	_settings_provider_drafts = _provider_configs.duplicate(true)
	_settings_remember_drafts = _provider_remember_secrets.duplicate(true)
	_populate_provider_options(_settings_provider_id)
	_rebuild_settings_provider_fields(
		_settings_provider_id,
		_settings_provider_draft(_settings_provider_id)
	)
	return true


func _sanitize_provider_field(raw_field) -> Dictionary:
	if not raw_field is Dictionary:
		return {}
	var source: Dictionary = raw_field
	var key := str(source.get("key", "")).strip_edges()
	var field_type := str(source.get("type", "text"))
	if key.is_empty() or key.length() > 128 or not ["text", "url", "secret", "select"].has(field_type):
		return {}
	var field := {
		"key": key,
		"label": str(source.get("label", key)).left(128),
		"type": field_type,
		"required": bool(source.get("required", false)),
	}
	if source.has("description"):
		field["description"] = str(source.get("description", "")).left(512)
	if source.has("default_value"):
		field["default_value"] = str(source.get("default_value", ""))
	if field_type == "select":
		var options: Array = []
		var raw_options = source.get("options", [])
		if raw_options is Array:
			for raw_option in raw_options:
				if not raw_option is Dictionary:
					continue
				var option: Dictionary = raw_option
				var value := str(option.get("value", ""))
				if value.is_empty():
					continue
				options.append({
					"value": value,
					"label": str(option.get("label", value)).left(128),
				})
		field["options"] = options
	return field


func _activate_builtin_provider_fallback() -> void:
	_provider_descriptors.clear()
	_ensure_builtin_provider_descriptor()
	_provider_id = DEFAULT_PROVIDER
	_settings_provider_id = DEFAULT_PROVIDER
	_settings_provider_drafts = _provider_configs.duplicate(true)
	_settings_remember_drafts = _provider_remember_secrets.duplicate(true)
	_populate_provider_options(DEFAULT_PROVIDER)
	_rebuild_settings_provider_fields(DEFAULT_PROVIDER, _settings_provider_draft(DEFAULT_PROVIDER))


func _finish_provider_sync() -> void:
	_provider_sync_in_flight = false
	_providers_ready = true
	_sync_legacy_connection_aliases()
	if _provider_config_is_complete(_provider_id, _provider_config(_provider_id)):
		_begin_model_sync()
	else:
		_set_status("Open settings", Color("d5a15d"))
		_update_controls()


func _begin_model_sync() -> void:
	if _model_sync_in_flight or _turn_in_progress:
		return
	if _server_ready and not _providers_ready:
		_set_status("Waiting for providers", Color("d5a15d"))
		_update_controls()
		return
	if not _provider_config_is_complete(_provider_id, _provider_config(_provider_id)):
		_open_settings()
		return
	if not _server_ready:
		_models_ready = false
		_set_status("Waiting for runtime", Color("d5a15d"))
		_update_controls()
		return
	_models_ready_before_sync = _models_ready and _connection_fingerprint() == _configured_fingerprint
	_models_ready = false
	_model_sync_in_flight = true
	_configure_purpose = ""
	_configure_fingerprint_pending = ""
	_set_status("Syncing models", Color("d5a15d"))
	_update_controls()
	if _connection_fingerprint() != _configured_fingerprint:
		_configure_purpose = "models"
		_configure_fingerprint_pending = _connection_fingerprint()
		_send_request("configure", _build_runtime_config())
	else:
		_send_request("models.list", {})


static func _provider_auth_status(error: Dictionary) -> int:
	var data_value: Variant = error.get("data")
	if data_value is Dictionary:
		var status := int((data_value as Dictionary).get(
			"status",
			(data_value as Dictionary).get("http_status", 0)
		))
		if status == 401 or status == 403:
			return status
	var message := str(error.get("message", "")).to_lower()
	if message.contains("http 401"):
		return 401
	if message.contains("http 403"):
		return 403
	return 0


static func _is_provider_auth_error(error: Dictionary) -> bool:
	if _is_provider_billing_error(error):
		return false
	var code := str(error.get("code", ""))
	return (
		code == "PROVIDER_AUTH_FAILED"
		or code == "PROVIDER_AUTHENTICATION_FAILED"
		or _provider_auth_status(error) > 0
	)


static func _is_provider_billing_error(error: Dictionary) -> bool:
	var code := str(error.get("code", ""))
	if code == "PROVIDER_BILLING_FAILED" or code == "PROVIDER_CREDITS_EXHAUSTED":
		return true
	var message := str(error.get("message", "")).to_lower()
	return (
		message.contains("creditserror")
		or message.contains("insufficient balance")
		or message.contains("insufficient credits")
	)


func _provider_auth_message(error: Dictionary) -> String:
	var status := _provider_auth_status(error)
	if status > 0:
		return _t(
			"Provider authentication failed (HTTP %d). Open Connection settings and check the API key or account permissions."
		) % status
	return _t(
		"Provider authentication failed. Open Connection settings and check the API key or account permissions."
	)


func _provider_billing_message(_error: Dictionary) -> String:
	return _t(
		"Provider balance is insufficient. Add credits in the provider billing settings, then retry."
	)


func _report_provider_auth_failure(error: Dictionary) -> void:
	var message := _provider_auth_message(error)
	_set_status("Authentication failed", Color("d87979"))
	_status.tooltip_text = message
	var notice_key := "%s:provider_auth" % _connection_fingerprint()
	if notice_key == _reported_connection_notice_key:
		return
	_reported_connection_notice_key = notice_key
	_append_system(message)


func _report_provider_billing_failure(error: Dictionary) -> void:
	var message := _provider_billing_message(error)
	_set_status("Insufficient balance", Color("d87979"))
	_status.tooltip_text = message
	var notice_key := "%s:provider_billing" % _connection_fingerprint()
	if notice_key == _reported_connection_notice_key:
		return
	_reported_connection_notice_key = notice_key
	_append_system(message)


func _finish_model_sync(success: bool, model_count: int = 0) -> void:
	_model_sync_in_flight = false
	var restored_previous_models := not success and _models_ready_before_sync
	_models_ready = success or restored_previous_models
	_models_ready_before_sync = false
	if success:
		_reported_connection_notice_key = ""
		_set_status("Ready", Color("72c98a"))
		_status.tooltip_text = _t("%d models available") % model_count
	elif restored_previous_models:
		_set_status("Model refresh failed", Color("d87979"))
	else:
		_set_status("Model sync failed", Color("d87979"))
	_update_controls()
	if success and not _sessions_ready:
		_begin_session_sync(true)


func _populate_models(raw_models: Array) -> bool:
	var previous_model := _selected_model()
	var model_ids: Array[String] = []
	var seen := {}
	_model_capabilities.clear()
	for raw_model in raw_models:
		if not raw_model is Dictionary:
			continue
		var entry: Dictionary = raw_model
		var model_id := str(entry.get("id", "")).strip_edges()
		if model_id.is_empty() or seen.has(model_id):
			continue
		seen[model_id] = true
		model_ids.append(model_id)
		var raw_capabilities = entry.get("capabilities", null)
		if raw_capabilities is Dictionary:
			_model_capabilities[model_id] = (raw_capabilities as Dictionary).duplicate(true)
	if model_ids.is_empty():
		return false
	_models_provider_id = _provider_id
	_model_select.clear()
	var selected_index := 0
	for model_id in model_ids:
		_model_select.add_item(_model_label(model_id))
		var index := _model_select.item_count - 1
		_model_select.set_item_metadata(index, model_id)
		_model_select.get_popup().set_item_tooltip(index, model_id)
		if model_id == previous_model or (previous_model.is_empty() and model_id == _default_model_for_provider()):
			selected_index = index
	var default_model := _default_model_for_provider()
	if not model_ids.has(previous_model) and model_ids.has(default_model):
		selected_index = model_ids.find(default_model)
	_model_select.select(selected_index)
	_on_model_selected(selected_index)
	return true


func _model_label(model_id: String) -> String:
	if model_id.length() <= MODEL_LABEL_MAX_LENGTH:
		return model_id
	return "%s..." % model_id.left(MODEL_LABEL_MAX_LENGTH - 3)


func _on_model_selected(index: int) -> void:
	if _model_select == null or index < 0 or index >= _model_select.item_count:
		return
	var model_id := str(_model_select.get_item_metadata(index))
	_model_select.tooltip_text = model_id
	if _reasoning_select != null:
		_rebuild_reasoning_options(model_id)
	_update_controls()


func _selected_model_image_capability() -> int:
	var model_id := _selected_model()
	if model_id.is_empty() or not _model_capabilities.has(model_id):
		return IMAGE_CAPABILITY_UNKNOWN
	var capabilities_value: Variant = _model_capabilities.get(model_id)
	if not capabilities_value is Dictionary:
		return IMAGE_CAPABILITY_UNKNOWN
	return _image_input_capability(capabilities_value as Dictionary)


static func _image_input_capability(capabilities: Dictionary) -> int:
	if capabilities.has("image_input"):
		var direct_value: Variant = capabilities.get("image_input")
		if direct_value is bool:
			return IMAGE_CAPABILITY_SUPPORTED if bool(direct_value) else IMAGE_CAPABILITY_UNSUPPORTED
		if direct_value is Dictionary:
			var direct: Dictionary = direct_value
			var status := str(direct.get("status", "")).strip_edges().to_lower()
			if status == "supported":
				return IMAGE_CAPABILITY_SUPPORTED
			if status == "unsupported":
				return IMAGE_CAPABILITY_UNSUPPORTED
			if status == "unknown":
				return IMAGE_CAPABILITY_UNKNOWN
			if direct.has("supported") and direct.get("supported") is bool:
				return (
					IMAGE_CAPABILITY_SUPPORTED
					if bool(direct.get("supported"))
					else IMAGE_CAPABILITY_UNSUPPORTED
				)
	var modalities_value: Variant = capabilities.get("input_modalities")
	if modalities_value is Array:
		var modalities: Array = modalities_value
		for modality_value in modalities:
			if str(modality_value).strip_edges().to_lower() == "image":
				return IMAGE_CAPABILITY_SUPPORTED
		return IMAGE_CAPABILITY_UNSUPPORTED
	var input_value: Variant = capabilities.get("input")
	if input_value is Dictionary:
		var input_capabilities: Dictionary = input_value
		if input_capabilities.has("image"):
			var image_value: Variant = input_capabilities.get("image")
			if image_value is bool:
				return IMAGE_CAPABILITY_SUPPORTED if bool(image_value) else IMAGE_CAPABILITY_UNSUPPORTED
			if image_value is Dictionary and (image_value as Dictionary).has("supported"):
				return (
					IMAGE_CAPABILITY_SUPPORTED
					if bool((image_value as Dictionary).get("supported"))
					else IMAGE_CAPABILITY_UNSUPPORTED
				)
	return IMAGE_CAPABILITY_UNKNOWN


func _rebuild_reasoning_options(model_id: String) -> void:
	if _reasoning_select == null:
		return
	var previous_effort := _selected_reasoning()
	var efforts: Array[String] = []
	var default_effort := ""
	if _model_capabilities.has(model_id):
		var raw_capabilities = _model_capabilities.get(model_id, {})
		if raw_capabilities is Dictionary:
			var raw_reasoning = (raw_capabilities as Dictionary).get("reasoning", null)
			if raw_reasoning is Dictionary:
				var reasoning: Dictionary = raw_reasoning
				var raw_efforts = reasoning.get("efforts", [])
				if raw_efforts is Array:
					for raw_effort in raw_efforts:
						var effort := str(raw_effort).strip_edges()
						if not effort.is_empty() and not efforts.has(effort):
							efforts.append(effort)
				default_effort = str(reasoning.get("default_effort", ""))
	if previous_effort == "max" and not efforts.has("max"):
		previous_effort = "xhigh"
	_reasoning_select.clear()
	_reasoning_select.visible = not efforts.is_empty()
	if efforts.is_empty():
		_reasoning_select.tooltip_text = _t("Reasoning effort is not available for this model")
		_update_controls()
		return
	for effort in efforts:
		_reasoning_select.add_item(effort)
		_reasoning_select.set_item_metadata(_reasoning_select.item_count - 1, effort)
	var selected_index := efforts.find(previous_effort)
	if selected_index < 0:
		selected_index = efforts.find(default_effort)
	if selected_index < 0:
		selected_index = 0
	_reasoning_select.select(selected_index)
	_on_reasoning_selected(selected_index)


func _on_reasoning_selected(index: int) -> void:
	if _reasoning_select == null or index < 0 or index >= _reasoning_select.item_count:
		return
	_reasoning_select.tooltip_text = str(_reasoning_select.get_item_metadata(index))


func _on_approval_mode_selected(index: int) -> void:
	if _approval_mode_select == null or index < 0 or index >= _approval_mode_select.item_count:
		return
	if _turn_in_progress:
		_sync_approval_controls()
		return
	var mode := str(_approval_mode_select.get_item_metadata(index))
	if mode != APPROVAL_MODE_ASK and mode != APPROVAL_MODE_AUTO_EDITS:
		_sync_approval_controls()
		return
	_set_auto_approve_edits_enabled(mode == APPROVAL_MODE_AUTO_EDITS, true)


func _set_auto_approve_edits_enabled(enabled: bool, persist: bool = false) -> void:
	_auto_approve_edits_enabled = enabled
	_sync_approval_controls()
	if persist:
		_persist_auto_approve_setting()


func _sync_approval_controls() -> void:
	if _auto_approve_edits != null:
		_auto_approve_edits.button_pressed = _auto_approve_edits_enabled
	if _approval_mode_select == null:
		return
	var mode := _selected_approval_mode()
	for index in _approval_mode_select.item_count:
		if str(_approval_mode_select.get_item_metadata(index)) == mode:
			_approval_mode_select.select(index)
			break
	_approval_mode_select.tooltip_text = (
		_t("Edits, commands, and game starts are approved automatically.")
		if mode == APPROVAL_MODE_AUTO_EDITS
		else _t("Edits, commands, and game starts require your approval.")
	)


func _selected_approval_mode() -> String:
	return APPROVAL_MODE_AUTO_EDITS if _auto_approve_edits_enabled else APPROVAL_MODE_ASK


func _selected_model() -> String:
	if _model_select == null or _model_select.item_count == 0 or _model_select.selected < 0:
		return ""
	return str(_model_select.get_item_metadata(_model_select.selected))


func _selected_reasoning() -> String:
	if (
		_reasoning_select == null
		or not _reasoning_select.visible
		or _reasoning_select.item_count == 0
		or _reasoning_select.selected < 0
	):
		return ""
	return str(_reasoning_select.get_item_metadata(_reasoning_select.selected))


func _default_model_for_provider() -> String:
	var raw_descriptor = _provider_descriptors.get(_provider_id, {})
	if raw_descriptor is Dictionary:
		var configured_default := str((raw_descriptor as Dictionary).get("default_model", "")).strip_edges()
		if not configured_default.is_empty():
			return configured_default
	return DEFAULT_MODEL if _provider_id == DEFAULT_PROVIDER else ""


func _build_runtime_config() -> Dictionary:
	var model := _selected_model()
	if model.is_empty() or _models_provider_id != _provider_id:
		model = _default_model_for_provider()
	return {
		"provider_id": _provider_id,
		"provider_config": _provider_config(_provider_id),
		"model": model,
		"approval_mode": "ask",
	}


func _connection_fingerprint() -> String:
	var config := _provider_config(_provider_id)
	if not _provider_config_is_complete(_provider_id, config):
		return ""
	return _sha256_text("%s\n%s" % [_provider_id, _stable_config_value(config)])


func _stable_config_value(value) -> String:
	if value is Dictionary:
		var dictionary: Dictionary = value
		var keys: Array = dictionary.keys()
		keys.sort()
		var dictionary_entries: Array[String] = []
		for raw_key in keys:
			dictionary_entries.append("%s:%s" % [JSON.stringify(str(raw_key)), _stable_config_value(dictionary[raw_key])])
		return "{%s}" % ",".join(dictionary_entries)
	if value is Array:
		var array_entries: Array[String] = []
		for entry in value:
			array_entries.append(_stable_config_value(entry))
		return "[%s]" % ",".join(array_entries)
	return JSON.stringify(value)


func _sha256_text(value: String) -> String:
	var hashing := HashingContext.new()
	hashing.start(HashingContext.HASH_SHA256)
	hashing.update(value.to_utf8_buffer())
	return hashing.finish().hex_encode()


func _normalize_base_url(value: String) -> String:
	var normalized := value.strip_edges()
	while normalized.ends_with("/") and not normalized.ends_with("://"):
		normalized = normalized.trim_suffix("/")
	return normalized


func _base_url_has_credentials(value: String) -> bool:
	var scheme_index := value.find("://")
	if scheme_index < 0:
		return false
	var authority := value.substr(scheme_index + 3).get_slice("/", 0)
	return authority.contains("@")


func _is_loopback_http_url(value: String) -> bool:
	var authority := value.trim_prefix("http://").get_slice("/", 0)
	return (
		authority == "localhost"
		or authority.begins_with("localhost:")
		or authority == "127.0.0.1"
		or authority.begins_with("127.0.0.1:")
		or authority == "[::1]"
		or authority.begins_with("[::1]:")
	)


func _start_runtime() -> void:
	if _shutting_down:
		return
	if _runtime_pid > 0 and OS.is_process_running(_runtime_pid):
		return
	var server_path := _resolve_runtime_server_path()
	if server_path.is_empty():
		_set_status("Runtime package is missing", Color("d87979"))
		return
	var node_bin := _resolve_node_binary()
	_runtime_pid = OS.create_process(
		node_bin,
		PackedStringArray([
			server_path,
			"--workspace", _workspace_path,
			"--data-dir", OS.get_user_data_dir(),
			"--port", str(_runtime_port),
			"--token-sha256", _auth_token_hash,
		]),
		false
	)
	if _runtime_pid <= 0:
		_set_status("Could not start Node runtime", Color("d87979"))
		return
	_runtime_start_requested_at_ms = Time.get_ticks_msec()
	_runtime_start_warning_reported = false


static func _resolve_runtime_server_path() -> String:
	for resource_path in [BUNDLED_RUNTIME_SERVER, DEVELOPMENT_RUNTIME_SERVER]:
		var absolute_path := ProjectSettings.globalize_path(resource_path)
		if FileAccess.file_exists(absolute_path):
			return absolute_path
	return ""


static func _resolve_node_binary() -> String:
	var configured := OS.get_environment("GODOTX_NODE_BIN").strip_edges()
	if configured.is_empty():
		configured = OS.get_environment("GODETX_NODE_BIN").strip_edges()
	if not configured.is_empty():
		return configured
	if OS.get_name() == "Windows":
		for resource_path in BUNDLED_WINDOWS_NODE_CANDIDATES:
			var absolute_path := ProjectSettings.globalize_path(resource_path)
			if FileAccess.file_exists(absolute_path):
				return absolute_path
	return "node"


func _submit() -> void:
	if _send_button.disabled:
		return
	if _socket.get_ready_state() != WebSocketPeer.STATE_OPEN or not _server_ready:
		_append_system("Runtime is not connected.")
		return
	if not _provider_config_is_complete(_provider_id, _provider_config(_provider_id)):
		_open_settings()
		return
	if not _models_ready or _selected_model().is_empty():
		_append_system("Sync the model list before sending a message.")
		_begin_model_sync()
		return
	if not _sessions_ready:
		_append_system("Wait for saved conversations to finish loading.")
		_begin_session_sync(true)
		return
	var prompt_text := _prompt.text.strip_edges()
	if prompt_text.is_empty() and _pending_attachments.is_empty():
		return
	if (
		not _pending_attachments.is_empty()
		and _selected_model_image_capability() == IMAGE_CAPABILITY_UNSUPPORTED
	):
		_append_system(_t("The selected model does not support image input."))
		return
	if not _save_editor_scripts():
		_append_system("Save open scripts before sending a task. The task was not sent.")
		return
	var editor_context := _collect_editor_context()
	var turn_attachments := _pending_attachments.duplicate(true)
	_queued_prompt = prompt_text
	_queued_turn_active = true
	_queued_model = _selected_model()
	_queued_reasoning = _selected_reasoning()
	_queued_runtime_automation_enabled = _runtime_automation_enabled
	_queued_attachments = turn_attachments
	_queued_editor_context = editor_context
	_turn_in_progress = true
	_update_controls()
	_prompt.clear()
	if _prompt.is_inside_tree():
		_prompt.grab_focus()
	_return_to_latest_session_history()
	_invalidate_session_snapshot_cache()
	_add_user_message(prompt_text, turn_attachments)
	_clear_pending_attachments()
	_begin_activity_indicator()
	if _connection_fingerprint() != _configured_fingerprint:
		_configure_purpose = "turn"
		_configure_fingerprint_pending = _connection_fingerprint()
		_send_request("configure", _build_runtime_config())
	elif _session_id.is_empty():
		_session_create_purpose = "turn"
		_session_sync_in_flight = true
		_send_request("session.create", {})
	else:
		_start_queued_turn()


func _start_queued_turn() -> void:
	if not _queued_turn_active or _session_id.is_empty():
		_fail_queued_turn("Runtime did not create a valid session.")
		return
	_reset_message_stream()
	_set_activity_phase("Thinking")
	_stop_button.disabled = false
	_set_status("Working", Color("d5a15d"))
	var editor_context := _queued_editor_context.duplicate(true)
	var scene_context_value = editor_context.get("scene_context", {})
	_pending_turn_scene_context = (
		(scene_context_value as Dictionary).duplicate(true)
		if scene_context_value is Dictionary
		else _empty_scene_context()
	)
	var primary_scene_id := _scene_context_primary_protocol_id(_pending_turn_scene_context)
	var primary_scene_value: Variant = null
	if not primary_scene_id.is_empty():
		primary_scene_value = primary_scene_id
	var runtime_prompt := _build_turn_prompt(_queued_prompt, editor_context)
	if runtime_prompt.strip_edges().is_empty() and not _queued_attachments.is_empty():
		runtime_prompt = "Inspect the attached image."
	var params := {
		"session_id": _session_id,
		"prompt": runtime_prompt,
		"display_prompt": _queued_prompt,
		"model": _queued_model,
		"primary_scene_id": primary_scene_value,
		"scene_leases": _scene_context_protocol_leases(_pending_turn_scene_context),
		"open_scene_paths": _open_scene_protocol_paths(editor_context),
		"runtime_automation_enabled": _queued_runtime_automation_enabled,
	}
	var attachment_refs := _attachment_protocol_refs(_queued_attachments)
	if not attachment_refs.is_empty():
		params["attachments"] = attachment_refs
	if not _queued_reasoning.is_empty():
		params["reasoning_effort"] = _queued_reasoning
	_send_request("turn.start", params)
	_queued_prompt = ""
	_queued_model = ""
	_queued_reasoning = ""
	_queued_runtime_automation_enabled = false
	_queued_attachments.clear()
	_queued_editor_context.clear()


func _build_turn_prompt(user_prompt: String, context: Dictionary = {}) -> String:
	return _format_turn_prompt(user_prompt, context)


func _collect_editor_context() -> Dictionary:
	var context := {
		"current_scene": "",
		"current_scene_root": "",
		"current_script": "",
		"open_scenes": PackedStringArray(),
		"scene_context": _empty_scene_context(),
	}
	if editor_interface == null:
		return context
	var scene_context: Dictionary = _empty_scene_context()
	if _editor_bridge != null:
		scene_context = _editor_bridge.capture_open_scene_context()
	context["scene_context"] = scene_context
	var primary_scene_id := str(scene_context.get("primary_scene_id", ""))
	var leases_value = scene_context.get("leases", {})
	var primary_lease: Dictionary = {}
	if leases_value is Dictionary:
		var primary_lease_value = (leases_value as Dictionary).get(primary_scene_id)
		if primary_lease_value is Dictionary:
			primary_lease = primary_lease_value
	var scene_root: Node
	var root_reference = primary_lease.get("root_ref")
	if root_reference is WeakRef:
		scene_root = root_reference.get_ref() as Node
	if scene_root == null:
		scene_root = editor_interface.get_edited_scene_root()
	if scene_root != null:
		var current_scene := _workspace_relative_resource_path(scene_root.scene_file_path)
		context["current_scene"] = current_scene if not current_scene.is_empty() else "<unsaved>"
		context["current_scene_root"] = "%s (%s)" % [scene_root.name, scene_root.get_class()]
	var script_editor := editor_interface.get_script_editor()
	if script_editor != null:
		var current_script := script_editor.get_current_script()
		if current_script != null:
			context["current_script"] = _workspace_relative_resource_path(current_script.resource_path)
	var open_scenes := PackedStringArray()
	for scene_path in editor_interface.get_open_scenes():
		if open_scenes.size() >= MAX_TURN_OPEN_SCENE_PATHS:
			break
		var relative_path := _workspace_relative_resource_path(str(scene_path))
		if not relative_path.is_empty():
			open_scenes.append(relative_path)
	context["open_scenes"] = open_scenes
	return context


static func _format_turn_prompt(user_prompt: String, context: Dictionary) -> String:
	var current_scene := str(context.get("current_scene", ""))
	var current_scene_root := str(context.get("current_scene_root", ""))
	var current_script := str(context.get("current_script", ""))
	var open_scenes_value = context.get("open_scenes", PackedStringArray())
	var scene_context_value = context.get("scene_context", {})
	var primary_scene_id := ""
	var open_scene_targets: Array[String] = []
	if scene_context_value is Dictionary:
		primary_scene_id = _scene_context_primary_protocol_id(scene_context_value)
		var leases_value = (scene_context_value as Dictionary).get("leases", {})
		if leases_value is Dictionary:
			for lease_value in (leases_value as Dictionary).values():
				if not lease_value is Dictionary or not bool(lease_value.get("available", false)):
					continue
				var target_path := _workspace_relative_resource_path(str(lease_value.get("scene_path", "")))
				if target_path.is_empty():
					target_path = "<unsaved>"
				open_scene_targets.append(
					"- scene_id: %s; path: %s; root: %s (%s)" % [
						str(lease_value.get("scene_id", "")),
						target_path,
						str(lease_value.get("scene_root_name", "")),
						str(lease_value.get("scene_root_type", "")),
					]
				)
	var has_open_scenes: bool = (
		(open_scenes_value is Array or open_scenes_value is PackedStringArray)
		and not open_scenes_value.is_empty()
	)
	if (
		current_scene.is_empty()
		and current_scene_root.is_empty()
		and current_script.is_empty()
		and not has_open_scenes
		and open_scene_targets.is_empty()
	):
		return user_prompt
	var lines := PackedStringArray(["<godot_editor_context>"])
	if not current_scene.is_empty():
		lines.append("current_scene: %s" % current_scene)
	if not current_scene_root.is_empty():
		lines.append("current_scene_root: %s" % current_scene_root)
	if not primary_scene_id.is_empty():
		lines.append("primary_scene_id: %s" % primary_scene_id)
	if not current_script.is_empty():
		lines.append("current_script: %s" % current_script)
	if has_open_scenes:
		lines.append("open_scenes:")
		for scene_path in open_scenes_value:
			lines.append("- %s" % str(scene_path))
	if not open_scene_targets.is_empty():
		lines.append("open_scene_targets:")
		for target in open_scene_targets:
			lines.append(target)
	lines.append("</godot_editor_context>")
	lines.append("")
	lines.append("User request:")
	lines.append(user_prompt)
	return "\n".join(lines)


static func _workspace_relative_resource_path(resource_path: String) -> String:
	return resource_path.trim_prefix("res://") if resource_path.begins_with("res://") else ""


static func _empty_scene_context() -> Dictionary:
	return {"primary_scene_id": "", "leases": {}}


static func _scene_context_protocol_leases(scene_context: Dictionary) -> Array:
	var result: Array = []
	var leases_value = scene_context.get("leases", {})
	if not leases_value is Dictionary:
		return result
	for lease_value in (leases_value as Dictionary).values():
		if not lease_value is Dictionary:
			continue
		var lease: Dictionary = lease_value
		if not _scene_lease_is_protocol_safe(lease):
			continue
		result.append({
			"scene_id": str(lease.get("scene_id", "")),
			"scene_path": str(lease.get("scene_path", "")),
			"scene_revision": str(lease.get("scene_revision", "")),
		})
	return result


static func _scene_context_primary_protocol_id(scene_context: Dictionary) -> String:
	var primary_scene_id := str(scene_context.get("primary_scene_id", ""))
	var leases_value = scene_context.get("leases", {})
	if primary_scene_id.is_empty() or not leases_value is Dictionary:
		return ""
	var lease_value = (leases_value as Dictionary).get(primary_scene_id)
	if not lease_value is Dictionary or not _scene_lease_is_protocol_safe(lease_value):
		return ""
	return primary_scene_id


static func _scene_lease_is_protocol_safe(lease: Dictionary) -> bool:
	var scene_id := str(lease.get("scene_id", ""))
	var scene_path := str(lease.get("scene_path", ""))
	var scene_revision := str(lease.get("scene_revision", ""))
	return (
		bool(lease.get("has_scene", false))
		and bool(lease.get("available", false))
		and not scene_id.is_empty()
		and scene_id.length() <= 128
		and (scene_path.is_empty() or scene_path.begins_with("res://"))
		and scene_path.length() <= 1024
		and not scene_revision.is_empty()
		and scene_revision.length() <= 128
	)


static func _scene_lease_protocol_fields_match(left: Dictionary, right: Dictionary) -> bool:
	return (
		str(left.get("scene_id", "")) == str(right.get("scene_id", ""))
		and str(left.get("scene_path", "")) == str(right.get("scene_path", ""))
		and str(left.get("scene_revision", "")) == str(right.get("scene_revision", ""))
	)


static func _open_scene_protocol_paths(context: Dictionary) -> Array[String]:
	var result: Array[String] = []
	var open_scenes_value = context.get("open_scenes", PackedStringArray())
	if not (open_scenes_value is Array or open_scenes_value is PackedStringArray):
		return result
	for scene_path_value in open_scenes_value:
		var relative_path := str(scene_path_value)
		if relative_path.is_empty() or relative_path == "<unsaved>":
			continue
		var resource_path := "res://%s" % relative_path
		if not result.has(resource_path):
			result.append(resource_path)
	return result


func _bind_pending_turn_scene_lease(turn_id: String) -> void:
	if turn_id.is_empty():
		_pending_turn_scene_context.clear()
		return
	_turn_scene_contexts[turn_id] = _pending_turn_scene_context.duplicate(true)
	_pending_turn_scene_context.clear()


func _clear_turn_scene_lease(turn_id: String) -> void:
	if not turn_id.is_empty():
		_turn_scene_contexts.erase(turn_id)


func _clear_turn_scene_leases() -> void:
	_pending_turn_scene_context.clear()
	_turn_scene_contexts.clear()


func _turn_scene_context_error(message: String) -> Dictionary:
	return {
		"ok": false,
		"error_code": "EDITOR_SCENE_CONTEXT_CHANGED",
		"error": "%s. No editor scene operation was executed." % message,
	}


func _validate_turn_scene_request(turn_id: String, data: Dictionary, tool_name: String) -> Dictionary:
	var context_value = _turn_scene_contexts.get(turn_id)
	if turn_id.is_empty() or not context_value is Dictionary:
		return _turn_scene_context_error("The editor request is not bound to an active task")
	var scene_context: Dictionary = context_value
	var request_lease_value = data.get("scene_lease")
	if not request_lease_value is Dictionary:
		return _turn_scene_context_error("The editor request is missing its scene lease")
	var request_lease: Dictionary = request_lease_value
	var scene_id := str(request_lease.get("scene_id", ""))
	var leases_value = scene_context.get("leases", {})
	if scene_id.is_empty() or not leases_value is Dictionary:
		return _turn_scene_context_error("The editor request has an invalid scene lease")
	var host_lease_value = (leases_value as Dictionary).get(scene_id)
	if not host_lease_value is Dictionary:
		return _turn_scene_context_error("The requested scene was not open when this task was submitted")
	var host_lease: Dictionary = host_lease_value
	if not _scene_lease_protocol_fields_match(host_lease, request_lease):
		return _turn_scene_context_error("The Runtime scene lease does not match the host task")
	var arguments_value = data.get("arguments", {})
	if arguments_value is Dictionary and (arguments_value as Dictionary).has("scene_id"):
		var argument_scene_id := str((arguments_value as Dictionary).get("scene_id", ""))
		if not argument_scene_id.is_empty() and argument_scene_id != scene_id:
			return _turn_scene_context_error("Editor tool arguments target a different scene lease")
	if tool_name == "editor_get_selection" and scene_id != str(scene_context.get("primary_scene_id", "")):
		return _turn_scene_context_error("Editor selection is only available for the task's primary scene")
	if _editor_bridge == null:
		return _turn_scene_context_error("Godot editor bridge is unavailable")
	var validation: Dictionary = _editor_bridge.validate_scene_lease(host_lease)
	if not bool(validation.get("ok", false)):
		return validation
	return {"ok": true, "scene_lease": host_lease}


func _advance_turn_scene_lease(turn_id: String, result: Dictionary) -> Dictionary:
	var context_value = _turn_scene_contexts.get(turn_id)
	if not context_value is Dictionary:
		return _turn_scene_context_error("The completed editor write has no active task context")
	var scene_context: Dictionary = context_value
	var leases_value = scene_context.get("leases", {})
	if not leases_value is Dictionary:
		return _turn_scene_context_error("The active task scene context is invalid")
	var scene_id := str(result.get("scene_id", ""))
	var lease_value = (leases_value as Dictionary).get(scene_id)
	if not lease_value is Dictionary:
		return _turn_scene_context_error("The completed editor write targeted an unbound scene")
	var lease: Dictionary = lease_value
	if (
		str(result.get("scene_path", "")) != str(lease.get("scene_path", ""))
		or str(result.get("previous_scene_revision", "")) != str(lease.get("scene_revision", ""))
	):
		return _turn_scene_context_error("The completed editor write returned a mismatched scene state")
	var next_revision := str(result.get("scene_revision", ""))
	if next_revision.is_empty() or next_revision.length() > 128:
		return _turn_scene_context_error("The completed editor write returned an invalid revision")
	lease["scene_revision"] = next_revision
	(leases_value as Dictionary)[scene_id] = lease
	scene_context["leases"] = leases_value
	_turn_scene_contexts[turn_id] = scene_context
	return {"ok": true}


func _fail_queued_turn(message: String) -> void:
	_configure_purpose = ""
	_configure_fingerprint_pending = ""
	_queued_prompt = ""
	_queued_turn_active = false
	_queued_model = ""
	_queued_reasoning = ""
	_queued_runtime_automation_enabled = false
	_queued_attachments.clear()
	_queued_editor_context.clear()
	_session_sync_in_flight = false
	_session_create_purpose = ""
	_clear_turn_scene_leases()
	_turn_in_progress = false
	_clear_editor_scene_write_grants()
	_stop_button.disabled = true
	_reset_message_stream()
	_finish_activity_indicator("Failed")
	_update_controls()
	_append_system(message)


func _stop_turn() -> void:
	_set_activity_phase("Stopping")
	if not _session_id.is_empty():
		_send_request("turn.cancel", {"session_id": _session_id})
	_clear_approval()
	_clear_editor_scene_write_grants()
	_clear_turn_scene_leases()



func _send_request(method: String, params: Dictionary, allow_during_shutdown: bool = false) -> String:
	if _shutting_down and not allow_during_shutdown:
		return ""
	if _socket.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return ""
	_request_id += 1
	var id := str(_request_id)
	_pending[id] = method
	var send_error: Error = _socket.send_text(JSON.stringify({
		"id": id,
		"method": method,
		"params": params,
	}))
	if send_error != OK:
		_pending.erase(id)
		return ""
	return id


func _handle_packet(text: String) -> void:
	var message = JSON.parse_string(text)
	if not message is Dictionary:
		_append_system("Invalid runtime message")
		return
	if message.has("event"):
		_handle_event(message.event)
	elif message.has("id"):
		_handle_response(message)


func _handle_response(message: Dictionary) -> void:
	var id := str(message.get("id", ""))
	var method := str(_pending.get(id, ""))
	_pending.erase(id)
	var image_generation_id := str(_image_generation_requests.get(id, ""))
	_image_generation_requests.erase(id)
	if method == "image.generate" or method == "image.edit" or method == "ui_kit.generate":
		_update_controls()
	if message.has("error"):
		var error: Dictionary = message.error
		var provider_billing_error := _is_provider_billing_error(error)
		var provider_auth_error := _is_provider_auth_error(error)
		var error_message: String
		if provider_billing_error:
			error_message = _provider_billing_message(error)
		elif provider_auth_error:
			error_message = _provider_auth_message(error)
		else:
			error_message = _t("%s: %s") % [method, _t(str(error.get("message", "Unknown error")))]
		if method == "image.generate" or method == "image.edit" or method == "ui_kit.generate":
			image_generation_failed.emit(image_generation_id, error_message)
			if provider_billing_error:
				_report_provider_billing_failure(error)
			elif provider_auth_error:
				_report_provider_auth_failure(error)
		elif method == "image.capabilities":
			image_capabilities_received.emit({"supported": false, "error": error_message})
			if provider_billing_error:
				_report_provider_billing_failure(error)
			elif provider_auth_error:
				_report_provider_auth_failure(error)
		elif method.begins_with("skills.") or method.begins_with("index."):
			skillx_operation_failed.emit(method, error_message)
		elif method == "providers.list":
			_activate_builtin_provider_fallback()
			_append_system("Provider discovery failed; using the built-in OpenAI-compatible provider.")
			_finish_provider_sync()
		elif method == "models.list" or (method == "configure" and _configure_purpose == "models"):
			_configure_purpose = ""
			_configure_fingerprint_pending = ""
			_finish_model_sync(false)
			if provider_billing_error:
				_report_provider_billing_failure(error)
			elif provider_auth_error:
				_report_provider_auth_failure(error)
			else:
				_append_system(error_message)
		elif method.begins_with("session."):
			_restore_session_sync_after_failure()
			_flush_session_diagnostics()
			if _queued_turn_active:
				_fail_queued_turn(error_message)
			else:
				_append_system(error_message)
		elif method == "configure" or method == "turn.start":
			_fail_queued_turn(error_message)
			if provider_billing_error:
				_set_status("Insufficient balance", Color("d87979"))
				_status.tooltip_text = error_message
			elif provider_auth_error:
				_set_status("Authentication failed", Color("d87979"))
				_status.tooltip_text = error_message
		else:
			if provider_billing_error:
				_report_provider_billing_failure(error)
			elif provider_auth_error:
				_report_provider_auth_failure(error)
			else:
				_append_system(error_message)
		return
	var result: Dictionary = message.get("result", {})
	if method == "image.capabilities":
		image_capabilities_received.emit(result)
	elif method == "image.generate" or method == "image.edit":
		var completed_image := result.duplicate(true)
		if not image_generation_id.is_empty():
			completed_image["generation_id"] = image_generation_id
		image_generation_completed.emit(completed_image)
	elif method == "ui_kit.generate":
		ui_kit_completed.emit(result)
	elif method == "skills.list" or method == "skills.refresh":
		skillx_snapshot_received.emit(result)
	elif method == "skills.get":
		var skill_value: Variant = result.get("skill", {})
		if skill_value is Dictionary:
			skillx_skill_received.emit(skill_value as Dictionary)
	elif method == "skills.save" or method == "skills.set_enabled":
		var updated_skill_value: Variant = result.get("skill", {})
		if updated_skill_value is Dictionary:
			skillx_skill_received.emit(updated_skill_value as Dictionary)
		request_skillx_snapshot(true)
	elif method == "skills.delete":
		request_skillx_snapshot(true)
	elif method == "index.status" or method == "index.rebuild":
		var index_value: Variant = result.get("index", {})
		if index_value is Dictionary:
			skillx_index_received.emit(index_value as Dictionary)
		if method == "index.rebuild":
			request_skillx_snapshot(true)
	elif method == "providers.list":
		var raw_providers = result.get("providers", [])
		if not (raw_providers is Array and _populate_providers(raw_providers)):
			_activate_builtin_provider_fallback()
			_append_system("The runtime returned no usable providers; using OpenAI compatible.")
		_finish_provider_sync()
	elif method == "configure":
		var response_fingerprint := _configure_fingerprint_pending
		_configure_fingerprint_pending = ""
		var purpose := _configure_purpose
		_configure_purpose = ""
		if response_fingerprint.is_empty():
			if purpose == "models":
				_finish_model_sync(false)
				_append_system("Runtime returned an untracked configure response.")
			else:
				_fail_queued_turn("Runtime returned an untracked configure response.")
			return
		_configured_fingerprint = response_fingerprint
		if response_fingerprint != _connection_fingerprint():
			if purpose == "models":
				_model_sync_in_flight = false
				_models_ready = false
				_models_ready_before_sync = false
				_begin_model_sync()
			else:
				_fail_queued_turn("Connection settings changed before configuration completed.")
			return
		if purpose == "models":
			_send_request("models.list", {})
		elif purpose == "turn":
			_begin_session_sync(true)
		else:
			_append_system("Runtime returned an unexpected configure response.")
	elif method == "session.create":
		var created_session_id := str(result.get("session_id", ""))
		var create_purpose := _session_create_purpose
		_session_create_purpose = ""
		if create_purpose == "turn":
			_session_id = created_session_id
			_persist_selected_session()
			_session_sync_in_flight = false
			_sessions_ready_before_sync = false
			_sessions_ready = not _session_id.is_empty()
			if _sessions_ready:
				_start_queued_turn()
			else:
				_fail_queued_turn("Runtime did not create a valid session.")
		elif created_session_id.is_empty():
			_restore_session_sync_after_failure()
			_append_system("Runtime did not create a valid session.")
		else:
			_session_get_target_id = created_session_id
			_send_request("session.get", {"session_id": created_session_id})
	elif method == "session.list":
		var restore_view := _session_list_restore_view
		_session_list_restore_view = false
		var raw_sessions = result.get("sessions", [])
		_capture_session_diagnostics(result)
		_populate_session_options(raw_sessions if raw_sessions is Array else [])
		var current_session_available := _select_session_control(_session_id)
		if not restore_view and current_session_available:
			if _session_snapshot.is_empty():
				_session_get_target_id = _session_id
				_session_get_refresh_only = true
				_send_request("session.get", {"session_id": _session_id})
			else:
				_session_sync_in_flight = false
				_sessions_ready_before_sync = false
				_sessions_ready = true
				if _sessions_ready and _models_ready and not _model_sync_in_flight:
					_set_status("Ready", Color("72c98a"))
				_update_controls()
				_flush_session_diagnostics()
		else:
			if not current_session_available:
				_session_id = ""
				_sessions_ready_before_sync = false
				_persist_selected_session()
			var target_session_id := _session_id if current_session_available else _first_session_id()
			if target_session_id.is_empty():
				_session_create_purpose = "restore"
				_send_request("session.create", {})
			else:
				_session_get_target_id = target_session_id
				_send_request("session.get", {"session_id": target_session_id})
	elif method == "session.get":
		var snapshot_value = result.get("session", {})
		if not snapshot_value is Dictionary:
			_restore_session_sync_after_failure()
			_flush_session_diagnostics()
			_append_system("Runtime returned an invalid conversation snapshot.")
			return
		var snapshot: Dictionary = snapshot_value
		var snapshot_session_id := str(snapshot.get("session_id", ""))
		if (
			snapshot_session_id.is_empty()
			or (
				not _session_get_target_id.is_empty()
				and snapshot_session_id != _session_get_target_id
			)
		):
			_restore_session_sync_after_failure()
			_flush_session_diagnostics()
			_append_system("Runtime returned an invalid conversation snapshot.")
			return
		_session_id = snapshot_session_id
		_session_get_target_id = ""
		var refresh_only := _session_get_refresh_only
		_session_get_refresh_only = false
		_persist_selected_session()
		_render_session_snapshot(snapshot)
		_flush_session_diagnostics()
		_session_sync_in_flight = false
		_sessions_ready_before_sync = false
		_sessions_ready = not _session_id.is_empty()
		if _sessions_ready and _models_ready and not _model_sync_in_flight:
			_set_status("Ready", Color("72c98a"))
		_update_controls()
		if _queued_turn_active:
			_start_queued_turn()
		elif not refresh_only:
			_begin_session_sync(false)
	elif method == "session.rename":
		_session_sync_in_flight = false
		_sessions_ready_before_sync = false
		_sessions_ready = true
		_begin_session_sync(false)
	elif method == "session.delete":
		_session_id = ""
		_persist_selected_session()
		_clear_conversation()
		_session_sync_in_flight = false
		_sessions_ready_before_sync = false
		_sessions_ready = false
		_begin_session_sync(true)
	elif method == "models.list":
		var raw_models = result.get("models", [])
		if raw_models is Array and _populate_models(raw_models):
			_finish_model_sync(true, _model_select.item_count)
		else:
			_finish_model_sync(false)
			_append_system("The provider returned no usable models.")


func _handle_event(event: Dictionary) -> void:
	if int(event.get("version", 0)) != 1:
		return
	var event_type := str(event.get("type", ""))
	var event_session_id := str(event.get("session_id", ""))
	var item_id := str(event.get("item_id", ""))
	var turn_id := str(event.get("turn_id", ""))
	var data: Dictionary = event.get("data", {})
	if event_type == "asset.progress":
		image_workflow_progress.emit(data)
		return
	if event_type == "editor.tool.request":
		_handle_editor_tool_request_event(data, event_session_id, turn_id)
		return
	if TURN_SCOPED_EVENTS.has(event_type):
		if not event_session_id.is_empty() and event_session_id != _session_id:
			return
		if event_type == "turn.started":
			if not _turn_in_progress or turn_id.is_empty():
				return
			if not _active_turn_id.is_empty() and _active_turn_id != turn_id:
				return
		else:
			if not _turn_in_progress or _active_turn_id.is_empty() or _active_turn_id != turn_id:
				return
	match event_type:
		"server.ready":
			var runtime_workspace := str(data.get("workspace", "")).replace("\\", "/").trim_suffix("/").to_lower()
			var expected_workspace := _workspace_path.replace("\\", "/").trim_suffix("/").to_lower()
			if runtime_workspace != expected_workspace:
				_set_status("Port collision", Color("d87979"))
				_append_system("Refused a runtime belonging to another project.")
				_socket.close(1008, "Workspace mismatch")
				return
			_server_ready = true
			_begin_provider_sync()
		"turn.started":
			_queued_turn_active = false
			_bind_activity_turn(turn_id)
			_clear_editor_scene_write_grants()
			_bind_pending_turn_scene_lease(turn_id)
			_set_activity_phase("Thinking")
		"context.prepared":
			_show_project_context(item_id, data)
			_set_activity_phase("Thinking")
		"message.delta":
			_set_activity_phase("Writing")
			_queue_assistant_delta(item_id, str(data.get("delta", "")))
		"reasoning.summary.delta":
			_set_activity_phase("Thinking")
			_queue_reasoning_delta(item_id, str(data.get("delta", "")))
		"message.completed":
			_flush_deltas()
			var completed_text := str(data.get("text", ""))
			if not bool(_message_items_with_deltas.get(item_id, false)) and not completed_text.is_empty():
				_set_activity_phase("Writing")
				_append_assistant_text(item_id, completed_text)
			_message_items_with_deltas.erase(item_id)
			_message_had_delta = false
			_delta_item_id = ""
			_reasoning_item_id = ""
		"tool.started":
			_flush_deltas()
			_set_activity_phase("Working")
			_begin_tool_message(item_id, data)
		"tool.output.delta":
			_set_activity_phase("Working")
			_append_tool_output(item_id, _format_tool_output_delta(item_id, data))
		"tool.completed":
			_complete_tool_message(item_id, data)
			_set_activity_phase("Thinking")
		"approval.requested":
			_set_activity_phase("Waiting for approval")
			_show_approval(data, turn_id)
		"approval.resolved":
			_set_activity_phase("Working")
			_clear_approval(str(data.get("request_id", "")))
		"file_change.proposed":
			_set_activity_phase("Working")
			_attach_tool_change_details(item_id, data)
		"file_change.applied":
			_set_activity_phase("Working")
			_refresh_files(data.get("files", []))
		"editor_change.proposed":
			_set_activity_phase("Working")
		"editor_change.applied":
			_set_activity_phase("Working")
			_attach_tool_change_details(item_id, data)
		"provider.fallback":
			_append_system(_t("Provider fell back to %s.") % str(data.get("to", "chat_completions")))
		"usage.updated":
			_update_activity_usage(data)
		"turn.completed":
			_clear_editor_scene_write_grants()
			_clear_turn_scene_lease(turn_id)
			var turn_status := str(data.get("status", "completed"))
			_finish_activity_indicator("Stopped" if turn_status == "interrupted" else "Worked")
			_reset_message_stream()
			_turn_in_progress = false
			_stop_button.disabled = true
			_update_controls()
			_set_status(_t(turn_status.capitalize()), Color("72c98a"))
			if _prompt.is_inside_tree():
				_prompt.grab_focus()
			_begin_session_sync(false)
		"turn.failed":
			_clear_editor_scene_write_grants()
			_clear_turn_scene_lease(turn_id)
			var turn_error := {
				"code": str(data.get("code", "")),
				"message": str(data.get("error", "Turn failed")),
				"data": data.get("data", {}),
			}
			var provider_billing_error := _is_provider_billing_error(turn_error)
			var provider_auth_error := _is_provider_auth_error(turn_error)
			if provider_billing_error:
				_report_provider_billing_failure(turn_error)
			elif provider_auth_error:
				_report_provider_auth_failure(turn_error)
			else:
				_append_system(str(data.get("error", "Turn failed")))
			_finish_activity_indicator("Failed")
			_reset_message_stream()
			_turn_in_progress = false
			_stop_button.disabled = true
			_update_controls()
			if not provider_billing_error and not provider_auth_error:
				_set_status("Failed", Color("d87979"))
			_begin_session_sync(false)


func _handle_editor_tool_request_event(
	data: Dictionary,
	event_session_id: String,
	turn_id: String
) -> void:
	var request_id := str(data.get("request_id", ""))
	if request_id.is_empty():
		_append_system("Runtime sent an editor tool request without a request ID.")
		return
	var tool_name := str(data.get("tool", ""))
	if not _register_editor_tool_response(request_id, tool_name):
		_append_system("Runtime repeated the pending %s editor tool request." % tool_name)
		return
	var context_error := _editor_tool_request_context_error(event_session_id, turn_id)
	if not context_error.is_empty():
		_send_editor_tool_result(request_id, tool_name, {
			"ok": false,
			"error_code": "EDITOR_TOOL_CONTEXT_MISMATCH",
			"error": context_error,
		})
		return
	_set_activity_phase("Inspecting editor")
	_handle_editor_tool_request(data, turn_id)


func _editor_tool_request_context_error(event_session_id: String, turn_id: String) -> String:
	if _session_id.is_empty() or event_session_id.is_empty() or event_session_id != _session_id:
		return "The editor tool request does not belong to the active conversation"
	if not _turn_in_progress:
		return "The editor tool request arrived without an active task"
	if _active_turn_id.is_empty() or turn_id.is_empty() or turn_id != _active_turn_id:
		return "The editor tool request does not belong to the active task"
	return ""


func _register_editor_tool_response(request_id: String, tool_name: String) -> bool:
	if request_id.is_empty() or _pending_editor_tool_responses.has(request_id):
		return false
	var synchronous := tool_name != "game_capture_screenshot"
	_pending_editor_tool_responses[request_id] = {
		"tool": tool_name,
		"synchronous": synchronous,
	}
	if synchronous and is_inside_tree():
		get_tree().create_timer(SYNC_EDITOR_TOOL_TIMEOUT_SECONDS).timeout.connect(
			_on_sync_editor_tool_timeout.bind(request_id, tool_name),
			CONNECT_ONE_SHOT
		)
	return true


func _on_sync_editor_tool_timeout(request_id: String, tool_name: String) -> void:
	var pending_value: Variant = _pending_editor_tool_responses.get(request_id)
	if not pending_value is Dictionary or not bool((pending_value as Dictionary).get("synchronous", false)):
		return
	_send_editor_tool_result(request_id, tool_name, {
		"ok": false,
		"error_code": "EDITOR_TOOL_HOST_TIMEOUT",
		"error": "The Godot editor stopped while executing this synchronous tool request",
	})


func _handle_editor_tool_request(data: Dictionary, turn_id: String = "") -> void:
	var request_id := str(data.get("request_id", ""))
	if request_id.is_empty():
		_append_system("Runtime sent an editor tool request without a request ID.")
		return
	var tool_name := str(data.get("tool", ""))
	var arguments_value = data.get("arguments", {})
	var result: Dictionary
	if tool_name.is_empty():
		result = {"ok": false, "error": "Editor tool name is required"}
	elif not arguments_value is Dictionary:
		result = {"ok": false, "error": "Editor tool arguments must be an object"}
	elif _editor_bridge == null:
		result = {"ok": false, "error": "Godot editor bridge is unavailable"}
	elif tool_name == "game_capture_screenshot":
		var deferred: Dictionary = _editor_bridge.execute_deferred(
			tool_name,
			arguments_value as Dictionary,
			_on_deferred_editor_tool_completed.bind(request_id, tool_name)
		)
		if bool(deferred.get("ok", false)) and bool(deferred.get("pending", false)):
			var operation_id := str(deferred.get("capture_id", ""))
			if operation_id.is_empty():
				result = {
					"ok": false,
					"error": "The deferred editor operation did not return an operation ID",
				}
			else:
				_deferred_editor_tool_requests[request_id] = {
					"tool": tool_name,
					"operation_id": operation_id,
				}
				get_tree().create_timer(DEFERRED_EDITOR_TOOL_TIMEOUT_SECONDS).timeout.connect(
					_on_deferred_editor_tool_timeout.bind(request_id, tool_name, operation_id),
					CONNECT_ONE_SHOT
				)
				return
		else:
			result = deferred
	else:
		var editor_arguments: Dictionary = arguments_value
		if SCENE_BOUND_EDITOR_TOOLS.has(tool_name):
			var scene_request := _validate_turn_scene_request(turn_id, data, tool_name)
			if not bool(scene_request.get("ok", false)):
				result = scene_request
			else:
				var scene_lease: Dictionary = scene_request.get("scene_lease", {})
				if tool_name == "scene_apply_operations":
					var authorization := _consume_editor_scene_write_grant(editor_arguments, turn_id)
					if not bool(authorization.get("ok", false)):
						result = authorization
					else:
						result = _editor_bridge.execute(tool_name, editor_arguments, scene_lease)
						if bool(result.get("ok", false)):
							var advance := _advance_turn_scene_lease(turn_id, result)
							if not bool(advance.get("ok", false)):
								_append_system(str(advance.get("error", "Could not advance scene context")))
				else:
					result = _editor_bridge.execute(tool_name, editor_arguments, scene_lease)
		else:
			result = _editor_bridge.execute(tool_name, editor_arguments, {})
	_send_editor_tool_result(request_id, tool_name, result)


func _on_deferred_editor_tool_completed(
	result: Dictionary,
	request_id: String,
	tool_name: String
) -> void:
	if not _deferred_editor_tool_requests.has(request_id):
		return
	_deferred_editor_tool_requests.erase(request_id)
	_send_editor_tool_result(request_id, tool_name, result)


func _on_deferred_editor_tool_timeout(
	request_id: String,
	tool_name: String,
	operation_id: String
) -> void:
	if not _deferred_editor_tool_requests.has(request_id):
		return
	_deferred_editor_tool_requests.erase(request_id)
	if _editor_bridge != null:
		_editor_bridge.cancel_deferred(
			tool_name,
			operation_id,
			"The running game screenshot timed out"
		)
	_send_editor_tool_result(request_id, tool_name, {
		"ok": false,
		"error": "The running game screenshot timed out",
	})


func _cancel_deferred_editor_tool_requests(reason: String) -> void:
	var pending_requests: Dictionary = _deferred_editor_tool_requests.duplicate(true)
	_deferred_editor_tool_requests.clear()
	if _editor_bridge == null:
		return
	for pending_value in pending_requests.values():
		if not pending_value is Dictionary:
			continue
		var pending: Dictionary = pending_value as Dictionary
		_editor_bridge.cancel_deferred(
			str(pending.get("tool", "")),
			str(pending.get("operation_id", "")),
			reason
		)


func _send_editor_tool_result(request_id: String, tool_name: String, result: Dictionary) -> void:
	if request_id.is_empty() or not _pending_editor_tool_responses.has(request_id):
		return
	if _shutting_down:
		_pending_editor_tool_responses.erase(request_id)
		return
	var encoded_result := JSON.stringify(result)
	if encoded_result.to_utf8_buffer().size() > EDITOR_TOOL_RESULT_LIMIT:
		if tool_name == "scene_apply_operations" and bool(result.get("ok", false)):
			result = _compact_scene_mutation_result(result)
		else:
			result = {
				"ok": false,
				"error": "Editor tool result exceeded the %d byte limit" % EDITOR_TOOL_RESULT_LIMIT,
			}
	var response_id := _send_request(
		"editor.tool.respond",
		{"request_id": request_id, "result": result}
	)
	_pending_editor_tool_responses.erase(request_id)
	if response_id.is_empty():
		_append_system("The editor could not send the %s tool response to Runtime." % tool_name)
		if _socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
			_socket.close(1011, "Editor tool response could not be sent")


func _compact_scene_mutation_result(result: Dictionary) -> Dictionary:
	return {
		"ok": true,
		"operation_id": str(result.get("operation_id", "")),
		"scene_id": str(result.get("scene_id", "")),
		"scene_path": str(result.get("scene_path", "")),
		"previous_scene_revision": str(result.get("previous_scene_revision", "")),
		"scene_revision": str(result.get("scene_revision", "")),
		"action_name": str(result.get("action_name", "")),
		"undo_action": str(result.get("undo_action", "")),
		"operation_count": int(result.get("operation_count", 0)),
		"change_count": int(result.get("change_count", 0)),
		"changes": [],
		"changes_truncated": true,
		"result_truncated": true,
		"warning": "Applied successfully, but detailed change output exceeded the editor response limit.",
		"replayed": bool(result.get("replayed", false)),
	}


func _show_approval(data: Dictionary, turn_id: String = "") -> void:
	_clear_approval()
	_approval_request_id = str(data.get("request_id", ""))
	if _approval_request_id.is_empty():
		_append_system("Runtime sent an invalid approval request.")
		return
	var category := str(data.get("category", ""))
	_approval_category = category
	_approval_change_id = str(data.get("change_id", ""))
	_approval_turn_id = turn_id
	var preview_value = data.get("preview", "")
	_approval_preview = preview_value.duplicate(true) if preview_value is Dictionary else {}
	if category == "editor_scene" and (
		not _editor_scene_approval_is_valid()
		or not bool(_validate_editor_scene_approval_context().get("ok", false))
	):
		_append_system("Runtime sent an invalid live scene approval request. The change was declined.")
		_send_request("approval.respond", {"request_id": _approval_request_id, "decision": "decline"})
		_clear_approval(_approval_request_id)
		return
	if _should_auto_approve(category):
		_resolve_approval("accept")
		return
	var title_text := _t(str(data.get("title", "Approval required")))
	var body := str(data.get("diff", ""))
	if body.is_empty() and category == "editor_game":
		body = _t("Starting the game saves open editor files, runs project code in the existing Godot editor, and shares bounded debug output with the configured model.")
		var arguments_value = data.get("arguments", {})
		if arguments_value is Dictionary:
			var game_arguments := _format_tool_arguments("game_debug_start", arguments_value, 2048)
			if not game_arguments.is_empty():
				body += "\n\n%s" % game_arguments
	if body.is_empty():
		if preview_value is Dictionary:
			var preview: Dictionary = preview_value
			body = _format_tool_arguments("scene_apply_operations", {
				"scene_id": preview.get("scene_id", ""),
				"scene_revision": preview.get("scene_revision", ""),
				"operations": preview.get("changes", []),
			}, 2048)
			body = _limit_tool_detail(body)
		else:
			body = str(preview_value)
	if body.is_empty() and data.has("command"):
		body = _t("Command: %s\nWorking directory: %s") % [str(data.command), str(data.get("cwd", ""))]
	_approval_dialog.title = title_text
	_approval_diff.text = body
	_approval_dialog.popup_centered_ratio(0.82)


func _should_auto_approve(category: String) -> bool:
	return _auto_approve_edits_enabled and _is_auto_approvable_category(category)


static func _is_auto_approvable_category(category: String) -> bool:
	return (
		category == "file_change"
		or category == "godot_scene"
		or category == "editor_scene"
		or category == "command"
		or category == "editor_game"
	)


func _resolve_approval(decision: String) -> void:
	if _approval_request_id.is_empty():
		return
	var request_id := _approval_request_id
	if decision == "accept" or decision == "accept_for_session":
		if _approval_category == "editor_scene":
			var scene_context_validation := _validate_editor_scene_approval_context()
			if not bool(scene_context_validation.get("ok", false)):
				_append_system(str(scene_context_validation.get("error", "The target scene changed.")))
				_send_request("approval.respond", {"request_id": request_id, "decision": "decline"})
				_clear_approval(request_id)
				return
			_register_editor_scene_write_grant(
				_approval_change_id,
				_approval_preview,
				_approval_turn_id
			)
		elif not _save_editor_files():
			_append_system("Save open scripts before approving this change. The pending change was declined.")
			_send_request("approval.respond", {"request_id": request_id, "decision": "decline"})
			_clear_approval(request_id)
			return
	elif _approval_category == "editor_scene" and not _approval_change_id.is_empty():
		_editor_scene_write_grants.erase(_approval_change_id)
	_send_request("approval.respond", {"request_id": request_id, "decision": decision})
	_clear_approval(request_id)


func _clear_approval(request_id: String = "") -> void:
	if not request_id.is_empty() and request_id != _approval_request_id:
		return
	_approval_request_id = ""
	_approval_category = ""
	_approval_change_id = ""
	_approval_turn_id = ""
	_approval_preview.clear()
	if _approval_dialog != null:
		_approval_dialog.hide()


func _editor_scene_approval_is_valid() -> bool:
	if _approval_change_id.is_empty() or _approval_change_id.length() > 256 or _approval_preview.is_empty():
		return false
	var scene_id_value = _approval_preview.get("scene_id")
	var scene_revision_value = _approval_preview.get("scene_revision")
	var changes_value = _approval_preview.get("changes")
	if not scene_id_value is String or not scene_revision_value is String or not changes_value is Array:
		return false
	var scene_id: String = scene_id_value
	var scene_revision: String = scene_revision_value
	var changes: Array = changes_value
	return (
		not scene_id.is_empty()
		and scene_id.length() <= 128
		and not scene_revision.is_empty()
		and scene_revision.length() <= 128
		and not changes.is_empty()
		and changes.size() <= 64
	)


func _validate_editor_scene_approval_context() -> Dictionary:
	var context_value = _turn_scene_contexts.get(_approval_turn_id)
	if _approval_turn_id.is_empty() or not context_value is Dictionary:
		return _turn_scene_context_error("The live scene approval is not bound to an active task")
	var scene_context: Dictionary = context_value
	var scene_id := str(_approval_preview.get("scene_id", ""))
	var scene_revision := str(_approval_preview.get("scene_revision", ""))
	var leases_value = scene_context.get("leases", {})
	if scene_id.is_empty() or not leases_value is Dictionary:
		return _turn_scene_context_error("The live scene approval has an invalid target")
	var lease_value = (leases_value as Dictionary).get(scene_id)
	if not lease_value is Dictionary:
		return _turn_scene_context_error("The live scene approval targets a scene outside this task")
	var lease: Dictionary = lease_value
	if scene_revision != str(lease.get("scene_revision", "")):
		return _turn_scene_context_error("The live scene approval uses a stale scene revision")
	if _approval_preview.has("scene_path") and (
		str(_approval_preview.get("scene_path", "")) != str(lease.get("scene_path", ""))
	):
		return _turn_scene_context_error("The live scene approval uses a mismatched scene path")
	if _editor_bridge == null:
		return _turn_scene_context_error("Godot editor bridge is unavailable")
	return _editor_bridge.validate_scene_lease(lease)


func _register_editor_scene_write_grant(
	operation_id: String,
	preview: Dictionary,
	turn_id: String = ""
) -> void:
	_editor_scene_write_grants[operation_id] = {
		"turn_id": turn_id,
		"scene_id": preview.get("scene_id", ""),
		"scene_revision": preview.get("scene_revision", ""),
		"operations": (preview.get("changes", []) as Array).duplicate(true),
	}


func _consume_editor_scene_write_grant(arguments: Dictionary, turn_id: String = "") -> Dictionary:
	var operation_id_value = arguments.get("operation_id")
	if not operation_id_value is String or operation_id_value.is_empty():
		return {"ok": false, "error": "Live scene write is missing its approved operation ID"}
	var operation_id: String = operation_id_value
	if not _editor_scene_write_grants.has(operation_id):
		return {"ok": false, "error": "Live scene write was not approved by the Godot editor"}
	var grant_value = _editor_scene_write_grants.get(operation_id)
	_editor_scene_write_grants.erase(operation_id)
	if not grant_value is Dictionary:
		return {"ok": false, "error": "Live scene write approval is invalid"}
	var grant: Dictionary = grant_value
	var operations_value = arguments.get("operations")
	if (
		turn_id != str(grant.get("turn_id", ""))
		or str(arguments.get("scene_id", "")) != str(grant.get("scene_id", ""))
		or str(arguments.get("scene_revision", "")) != str(grant.get("scene_revision", ""))
		or not operations_value is Array
		or operations_value != grant.get("operations", [])
	):
		return {"ok": false, "error": "Live scene write does not match the approved preview"}
	return {"ok": true}


func _clear_editor_scene_write_grants() -> void:
	_editor_scene_write_grants.clear()


func _save_editor_files() -> bool:
	if not _save_editor_scripts():
		return false
	editor_interface.save_all_scenes()
	return true


func _save_editor_scripts() -> bool:
	_unsaved_open_script_paths.clear()
	if editor_interface == null:
		return false
	var script_editor := editor_interface.get_script_editor()
	if script_editor == null:
		return false
	for open_script_value in script_editor.get_open_scripts():
		var open_script := open_script_value as Script
		if open_script == null or not open_script.has_source_code():
			continue
		var resource_path := open_script.resource_path.replace("\\", "/")
		if resource_path.is_empty():
			_unsaved_open_script_paths.append("<untitled>")
			continue
		if (
			not resource_path.begins_with("res://")
			or resource_path.contains("::")
			or not resource_path.ends_with(".gd")
		):
			continue
		var source_file := FileAccess.open(resource_path, FileAccess.READ)
		if source_file == null:
			_unsaved_open_script_paths.append(resource_path)
			continue
		var disk_source := source_file.get_as_text()
		if _normalize_script_source(open_script.get_source_code()) != _normalize_script_source(disk_source):
			_unsaved_open_script_paths.append(resource_path)
	return _unsaved_open_script_paths.is_empty()


static func _normalize_script_source(source: String) -> String:
	return source.replace("\r\n", "\n").replace("\r", "\n")


static func _runtime_file_resource_path(file_value: Variant) -> String:
	var normalized := str(file_value).strip_edges().replace("\\", "/")
	if normalized.is_empty():
		return ""
	if normalized.begins_with("res://"):
		return normalized
	return "res://%s" % normalized.trim_prefix("/")


static func _is_godetx_plugin_resource_path(resource_path: String) -> bool:
	return resource_path.replace("\\", "/").begins_with(GODETX_PLUGIN_ROOT)


func _refresh_files(files: Array) -> void:
	if editor_interface == null or _shutting_down:
		return
	var filesystem := editor_interface.get_resource_filesystem()
	var detected_plugin_change := false
	for file in files:
		var resource_path := _runtime_file_resource_path(file)
		if resource_path.is_empty():
			continue
		if _is_godetx_plugin_resource_path(resource_path):
			if not _plugin_reload_required:
				detected_plugin_change = true
			_plugin_reload_required = true
			continue
		if FileAccess.file_exists(resource_path):
			filesystem.update_file(resource_path)
		if resource_path.ends_with(".tscn") and resource_path in editor_interface.get_open_scenes():
			editor_interface.reload_scene_from_path(resource_path)
	if detected_plugin_change:
		_update_controls()
		_append_system("GodotX plugin files changed. Reload the plugin before sending another task.")


func _append_system(text: String) -> void:
	_flush_deltas()
	_add_system_message(_display_error(text))


func _flush_deltas() -> void:
	if _delta_buffer.is_empty() and _reasoning_delta_buffer.is_empty():
		_next_delta_flush = 0
		return
	var assistant_delta := _delta_buffer
	var assistant_item_id := _delta_item_id
	var reasoning_delta := _reasoning_delta_buffer
	var reasoning_item := _reasoning_item_id
	_delta_buffer = ""
	_reasoning_delta_buffer = ""
	_next_delta_flush = 0
	if not assistant_delta.is_empty():
		_append_assistant_text(assistant_item_id, assistant_delta)
	if not reasoning_delta.is_empty():
		_append_reasoning_text(reasoning_item, reasoning_delta)


func _reset_message_stream() -> void:
	_flush_deltas()
	_delta_buffer = ""
	_delta_item_id = ""
	_reasoning_delta_buffer = ""
	_reasoning_item_id = ""
	_message_had_delta = false
	_message_items_with_deltas.clear()
	_next_delta_flush = 0


func _set_status(text: String, color: Color) -> void:
	if not _status:
		return
	var localized := _t(text)
	_status.text = localized
	_status.tooltip_text = localized
	_status.add_theme_color_override("font_color", color)
	if _status_dot != null:
		_status_dot.add_theme_stylebox_override("panel", _status_indicator_style(color))


func _label(text: String) -> Label:
	var result := Label.new()
	result.text = _t(text)
	return result


func _display_error(message: String) -> String:
	if message.begins_with("Current user request exceeds the safe context budget"):
		return _t("The current request is too long for a safe model context. Shorten it or split it into smaller tasks.")
	if message.contains("same normalized tool batch produced identical outputs twice"):
		return _t("The task stopped because the same tool calls returned unchanged results repeatedly. Change the instruction or project state before continuing.")
	if message.begins_with("Agent made no novel successful tool progress"):
		return _t("The task stopped after several attempts produced no new successful result. Change the instruction or project state before continuing.")
	if message.begins_with("Agent reached the emergency limit"):
		return _t("The task reached an internal runaway safety circuit. Review its progress before continuing.")
	if message.begins_with("Agent exceeded the configured maximum"):
		return _t("The connected client configured a fixed model-step limit and the task reached it.")
	if message.ends_with(SCENE_ERROR_SUFFIX):
		var cause := message.trim_suffix(SCENE_ERROR_SUFFIX)
		return _t("%s. No editor scene operation was executed.") % _t(cause)
	return _t(message)


func _t(message: String) -> String:
	return Localization.translate(message)


func _configure_socket(socket: WebSocketPeer) -> void:
	socket.inbound_buffer_size = SOCKET_BUFFER_SIZE
	socket.outbound_buffer_size = SOCKET_BUFFER_SIZE
	socket.max_queued_packets = 4096
