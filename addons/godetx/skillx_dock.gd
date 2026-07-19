@tool
extends VBoxContainer

const Localization := preload("res://addons/godetx/localization.gd")
const ICON_REFRESH := preload("res://addons/godetx/icons/refresh.svg")
const ICON_SEARCH := preload("res://addons/godetx/icons/search.svg")
const ICON_SKILL := preload("res://addons/godetx/icons/tool-agent.png")
const ICON_EDIT := preload("res://addons/godetx/icons/edit.svg")
const ICON_DELETE := preload("res://addons/godetx/icons/clear.svg")

var godetx_dock

var _status: Label
var _index_state: Label
var _index_summary: Label
var _skill_count: Label
var _skill_list: ItemList
var _scope: OptionButton
var _name_input: LineEdit
var _description_input: LineEdit
var _enabled: CheckButton
var _triggers_input: TextEdit
var _capabilities_input: TextEdit
var _instructions_input: TextEdit
var _save_button: Button
var _delete_button: Button
var _delete_dialog: ConfirmationDialog

var _skills: Array[Dictionary] = []
var _selected_id := ""
var _requested_initial_snapshot := false
var _snapshot_pending := false
var _loading_form := false
var _shutting_down := false
var _next_runtime_poll_ms := 0
var _next_scanning_poll_ms := 0


func _ready() -> void:
	name = "SkillXDock"
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	size_flags_vertical = Control.SIZE_EXPAND_FILL
	set_process(true)
	_build_ui()
	_connect_runtime_signals()
	_update_runtime_state()


func shutdown() -> void:
	if _shutting_down:
		return
	_shutting_down = true
	set_process(false)
	_disconnect_runtime_signals()


func _process(_delta: float) -> void:
	if _shutting_down:
		return
	var now := Time.get_ticks_msec()
	if now < _next_runtime_poll_ms:
		return
	_next_runtime_poll_ms = now + 500
	_update_runtime_state()


func _build_ui() -> void:
	add_theme_constant_override("separation", 8)

	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 8)
	add_child(header)
	var title := Label.new()
	title.text = "SkillX"
	title.add_theme_font_size_override("font_size", 16)
	header.add_child(title)
	_status = Label.new()
	_status.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_status.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	header.add_child(_status)
	var refresh_button := Button.new()
	refresh_button.icon = ICON_REFRESH
	refresh_button.flat = true
	refresh_button.custom_minimum_size = Vector2(32, 32)
	refresh_button.tooltip_text = _t("Refresh skills")
	refresh_button.pressed.connect(_request_snapshot.bind(true))
	header.add_child(refresh_button)

	var index_panel := PanelContainer.new()
	add_child(index_panel)
	var index_content := VBoxContainer.new()
	index_content.add_theme_constant_override("separation", 5)
	index_panel.add_child(index_content)
	var index_header := HBoxContainer.new()
	index_header.add_theme_constant_override("separation", 7)
	index_content.add_child(index_header)
	_add_section_icon(index_header, ICON_SEARCH)
	var index_title := Label.new()
	index_title.text = _t("Project semantic index")
	index_title.add_theme_font_size_override("font_size", 14)
	index_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	index_header.add_child(index_title)
	_index_state = Label.new()
	index_header.add_child(_index_state)
	_set_index_state("Offline", Color("8f98a3"))
	var rebuild_button := Button.new()
	rebuild_button.icon = ICON_REFRESH
	rebuild_button.flat = true
	rebuild_button.custom_minimum_size = Vector2(30, 30)
	rebuild_button.tooltip_text = _t("Rebuild project index")
	rebuild_button.pressed.connect(_rebuild_index)
	index_header.add_child(rebuild_button)
	_index_summary = Label.new()
	_index_summary.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_index_summary.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_index_summary.add_theme_color_override("font_color", Color("a9b0b8"))
	_index_summary.text = _t("Project index is waiting for the Runtime")
	index_content.add_child(_index_summary)

	var section_separator := HSeparator.new()
	add_child(section_separator)
	var skills_header := HBoxContainer.new()
	skills_header.add_theme_constant_override("separation", 7)
	add_child(skills_header)
	_add_section_icon(skills_header, ICON_SKILL)
	var skills_title := Label.new()
	skills_title.text = _t("Skills")
	skills_title.add_theme_font_size_override("font_size", 14)
	skills_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	skills_header.add_child(skills_title)
	_skill_count = Label.new()
	_skill_count.add_theme_color_override("font_color", Color("8f98a3"))
	_skill_count.text = _t("%d skills") % 0
	skills_header.add_child(_skill_count)
	var new_button := Button.new()
	new_button.text = _t("New skill")
	new_button.icon = ICON_EDIT
	new_button.flat = true
	new_button.pressed.connect(_new_skill)
	skills_header.add_child(new_button)

	_skill_list = ItemList.new()
	_skill_list.custom_minimum_size = Vector2(0, 150)
	_skill_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_skill_list.select_mode = ItemList.SELECT_SINGLE
	_skill_list.item_selected.connect(_on_skill_selected)
	add_child(_skill_list)

	var toolbar := HBoxContainer.new()
	toolbar.add_theme_constant_override("separation", 6)
	add_child(toolbar)
	_enabled = CheckButton.new()
	_enabled.text = _t("Enabled")
	_enabled.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_enabled.toggled.connect(_on_enabled_toggled)
	toolbar.add_child(_enabled)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(scroll)
	var form := VBoxContainer.new()
	form.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	form.add_theme_constant_override("separation", 6)
	scroll.add_child(form)

	_scope = OptionButton.new()
	_scope.add_item(_t("Project"))
	_scope.set_item_metadata(0, "project")
	_scope.add_item(_t("Personal"))
	_scope.set_item_metadata(1, "user")
	_add_field(form, _t("Scope"), _scope)

	_name_input = LineEdit.new()
	_name_input.placeholder_text = "godot-ui-builder"
	_add_field(form, _t("Skill name"), _name_input)

	_description_input = LineEdit.new()
	_description_input.placeholder_text = _t("When should this skill be used?")
	_add_field(form, _t("Description"), _description_input)

	_triggers_input = _text_editor(76)
	_triggers_input.placeholder_text = _t("One trigger phrase per line")
	_add_field(form, _t("Triggers"), _triggers_input)

	_capabilities_input = _text_editor(76)
	_capabilities_input.placeholder_text = _t("One ToolKernel capability per line")
	_add_field(form, _t("Capability hints"), _capabilities_input)

	_instructions_input = _text_editor(220)
	_instructions_input.placeholder_text = _t("Reusable instructions loaded only when this skill matches")
	_instructions_input.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_add_field(form, _t("Instructions"), _instructions_input)

	var action_row := HBoxContainer.new()
	action_row.add_theme_constant_override("separation", 6)
	form.add_child(action_row)
	_save_button = Button.new()
	_save_button.text = _t("Save skill")
	_save_button.icon = ICON_EDIT
	_save_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_save_button.pressed.connect(_save_skill)
	action_row.add_child(_save_button)
	_delete_button = Button.new()
	_delete_button.icon = ICON_DELETE
	_delete_button.tooltip_text = _t("Delete skill")
	_delete_button.pressed.connect(_confirm_delete)
	action_row.add_child(_delete_button)

	_delete_dialog = ConfirmationDialog.new()
	_delete_dialog.title = _t("Delete skill")
	_delete_dialog.dialog_text = _t("Delete this SkillX skill permanently?")
	_delete_dialog.confirmed.connect(_delete_skill)
	add_child(_delete_dialog)

	_new_skill()
	_set_status("Waiting for Runtime", Color("d5a15d"))


func _add_field(parent: VBoxContainer, label_text: String, control: Control) -> void:
	var label := Label.new()
	label.text = label_text
	label.add_theme_color_override("font_color", Color("8f98a3"))
	parent.add_child(label)
	control.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	parent.add_child(control)


func _add_section_icon(parent: HBoxContainer, texture: Texture2D) -> void:
	var icon := TextureRect.new()
	icon.texture = texture
	icon.custom_minimum_size = Vector2(18, 18)
	icon.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	icon.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	parent.add_child(icon)


func _text_editor(minimum_height: float) -> TextEdit:
	var editor := TextEdit.new()
	editor.custom_minimum_size = Vector2(0, minimum_height)
	editor.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	editor.scroll_fit_content_height = false
	return editor


func _connect_runtime_signals() -> void:
	if godetx_dock == null:
		return
	var connections := {
		"skillx_snapshot_received": Callable(self, "_on_snapshot_received"),
		"skillx_skill_received": Callable(self, "_on_skill_received"),
		"skillx_index_received": Callable(self, "_on_index_received"),
		"skillx_operation_failed": Callable(self, "_on_operation_failed"),
	}
	for signal_name: String in connections:
		var callback: Callable = connections[signal_name]
		if not godetx_dock.is_connected(signal_name, callback):
			godetx_dock.connect(signal_name, callback)


func _disconnect_runtime_signals() -> void:
	if godetx_dock == null or not is_instance_valid(godetx_dock):
		return
	var connections := {
		"skillx_snapshot_received": Callable(self, "_on_snapshot_received"),
		"skillx_skill_received": Callable(self, "_on_skill_received"),
		"skillx_index_received": Callable(self, "_on_index_received"),
		"skillx_operation_failed": Callable(self, "_on_operation_failed"),
	}
	for signal_name: String in connections:
		var callback: Callable = connections[signal_name]
		if godetx_dock.is_connected(signal_name, callback):
			godetx_dock.disconnect(signal_name, callback)


func _update_runtime_state() -> void:
	if godetx_dock == null or not is_instance_valid(godetx_dock):
		_set_status("Waiting for Runtime", Color("d5a15d"))
		_set_index_state("Offline", Color("8f98a3"))
		return
	var state_value: Variant = godetx_dock.call("skillx_state")
	var ready: bool = state_value is Dictionary and bool((state_value as Dictionary).get("ready", false))
	if not ready:
		_requested_initial_snapshot = false
		_snapshot_pending = false
		_set_status("Waiting for Runtime", Color("d5a15d"))
		_set_index_state("Offline", Color("8f98a3"))
		return
	if not _requested_initial_snapshot:
		_requested_initial_snapshot = true
		_request_snapshot(false)
	elif Time.get_ticks_msec() >= _next_scanning_poll_ms and _index_summary.has_meta("scanning"):
		_next_scanning_poll_ms = Time.get_ticks_msec() + 1500
		_request_snapshot(false)


func _request_snapshot(refresh: bool = false) -> void:
	if _snapshot_pending or godetx_dock == null:
		return
	var result_value: Variant = godetx_dock.call("request_skillx_snapshot", refresh)
	if not result_value is Dictionary or not bool((result_value as Dictionary).get("ok", false)):
		_set_status(str((result_value as Dictionary).get("error", _t("Runtime is not connected."))) if result_value is Dictionary else _t("Runtime is not connected."), Color("d87979"))
		return
	_snapshot_pending = true
	_set_status("Loading skills", Color("d5a15d"))


func _on_snapshot_received(snapshot: Dictionary) -> void:
	_snapshot_pending = false
	var skills_value: Variant = snapshot.get("skills", [])
	_skills.clear()
	if skills_value is Array:
		for skill_value in skills_value:
			if skill_value is Dictionary:
				_skills.append((skill_value as Dictionary).duplicate(true))
	_populate_skill_list()
	var index_value: Variant = snapshot.get("index", {})
	if index_value is Dictionary:
		_on_index_received(index_value as Dictionary)
	var diagnostics_value: Variant = snapshot.get("diagnostics", [])
	var diagnostic_count: int = 0
	if diagnostics_value is Array:
		diagnostic_count = (diagnostics_value as Array).size()
	_status.tooltip_text = _format_diagnostics(diagnostics_value)
	if diagnostic_count > 0:
		_set_status(_t("%d skill diagnostics") % diagnostic_count, Color("d5a15d"))
	else:
		_set_status("Ready", Color("72c98a"))


func _populate_skill_list() -> void:
	var preserve_id := _selected_id
	_skill_list.clear()
	if is_instance_valid(_skill_count):
		_skill_count.text = _t("%d skills") % _skills.size()
	var selected_index := -1
	for index in _skills.size():
		var skill := _skills[index]
		var scope_label := _scope_label(str(skill.get("scope", "project")))
		var enabled_mark := "" if bool(skill.get("enabled", true)) else _t(" (disabled)")
		_skill_list.add_item("%s  ·  %s%s" % [str(skill.get("name", "")), scope_label, enabled_mark])
		_skill_list.set_item_metadata(index, str(skill.get("id", "")))
		if str(skill.get("id", "")) == preserve_id:
			selected_index = index
	if selected_index >= 0:
		_skill_list.select(selected_index)
		_on_skill_selected(selected_index)
	elif not _skills.is_empty():
		_skill_list.select(0)
		_on_skill_selected(0)
	else:
		_new_skill()


func _on_skill_selected(index: int) -> void:
	if index < 0 or index >= _skill_list.item_count or godetx_dock == null:
		return
	_selected_id = str(_skill_list.get_item_metadata(index))
	_set_form_enabled(false)
	var result_value: Variant = godetx_dock.call("request_skillx_skill", _selected_id)
	if not result_value is Dictionary or not bool((result_value as Dictionary).get("ok", false)):
		_set_status(_t("Could not load skill"), Color("d87979"))


func _on_skill_received(skill: Dictionary) -> void:
	var skill_id := str(skill.get("id", ""))
	if not _selected_id.is_empty() and skill_id != _selected_id:
		return
	_selected_id = skill_id
	_loading_form = true
	_select_scope(str(skill.get("scope", "project")))
	_name_input.text = str(skill.get("name", ""))
	_description_input.text = str(skill.get("description", ""))
	_triggers_input.text = _join_string_array(skill.get("triggers", []))
	_capabilities_input.text = _join_string_array(skill.get("capabilities", []))
	_instructions_input.text = str(skill.get("instructions", ""))
	_enabled.button_pressed = bool(skill.get("enabled", true))
	_loading_form = false
	var readonly := bool(skill.get("readonly", false))
	_set_form_enabled(true, readonly)
	_set_status("Ready", Color("72c98a"))


func _new_skill() -> void:
	_selected_id = ""
	_loading_form = true
	_scope.select(0)
	_name_input.text = ""
	_description_input.text = ""
	_triggers_input.text = ""
	_capabilities_input.text = ""
	_instructions_input.text = ""
	_enabled.button_pressed = true
	_loading_form = false
	_set_form_enabled(true, false)
	_name_input.grab_focus()


func _save_skill() -> void:
	var skill_name := _name_input.text.strip_edges()
	var description := _description_input.text.strip_edges()
	var instructions := _instructions_input.text.strip_edges()
	if skill_name.is_empty() or description.is_empty() or instructions.is_empty():
		_set_status("Name, description, and instructions are required", Color("d87979"))
		return
	var scope_value := str(_scope.get_item_metadata(_scope.selected))
	var params := {
		"scope": scope_value,
		"name": skill_name,
		"description": description,
		"instructions": instructions,
		"triggers": _split_lines(_triggers_input.text),
		"capabilities": _split_lines(_capabilities_input.text),
		"enabled": _enabled.button_pressed,
	}
	_selected_id = "%s:%s" % [scope_value, skill_name]
	var result_value: Variant = godetx_dock.call("save_skillx_skill", params) if godetx_dock != null else {}
	if not result_value is Dictionary or not bool((result_value as Dictionary).get("ok", false)):
		_set_status(_t("Could not save skill"), Color("d87979"))
		return
	_set_status("Saving skill", Color("d5a15d"))


func _on_enabled_toggled(enabled_value: bool) -> void:
	if _loading_form or _selected_id.is_empty() or godetx_dock == null:
		return
	var result_value: Variant = godetx_dock.call("set_skillx_skill_enabled", _selected_id, enabled_value)
	if not result_value is Dictionary or not bool((result_value as Dictionary).get("ok", false)):
		_set_status(_t("Could not update skill"), Color("d87979"))


func _confirm_delete() -> void:
	if _selected_id.is_empty() or _delete_button.disabled:
		return
	_delete_dialog.popup_centered(Vector2i(420, 150))


func _delete_skill() -> void:
	if _selected_id.is_empty() or godetx_dock == null:
		return
	var result_value: Variant = godetx_dock.call("delete_skillx_skill", _selected_id)
	if not result_value is Dictionary or not bool((result_value as Dictionary).get("ok", false)):
		_set_status(_t("Could not delete skill"), Color("d87979"))
		return
	_selected_id = ""
	_set_status("Deleting skill", Color("d5a15d"))


func _rebuild_index() -> void:
	if godetx_dock == null:
		return
	var result_value: Variant = godetx_dock.call("rebuild_skillx_index")
	if not result_value is Dictionary or not bool((result_value as Dictionary).get("ok", false)):
		_set_status(_t("Could not rebuild project index"), Color("d87979"))
		return
	_index_summary.text = _t("Rebuilding project index")
	_index_summary.set_meta("scanning", true)
	_set_index_state("Indexing", Color("d5a15d"))
	_set_status("Indexing project", Color("d5a15d"))


func _on_index_received(index: Dictionary) -> void:
	var state := str(index.get("state", "idle"))
	if state == "scanning":
		_set_index_state("Indexing", Color("d5a15d"))
		_index_summary.text = _t("Indexing project")
		_index_summary.set_meta("scanning", true)
		return
	_index_summary.remove_meta("scanning")
	if state == "failed":
		_set_index_state("Failed", Color("d87979"))
		_index_summary.text = _t("Project index failed: %s") % str(index.get("error", ""))
		return
	if state == "idle":
		_set_index_state("Offline", Color("8f98a3"))
		_index_summary.text = _t("Project index is waiting for the Runtime")
		return
	_set_index_state("Ready", Color("72c98a"))
	_index_summary.text = (_t("%d files · %d symbols · %d references · %d dependencies") % [
		int(index.get("file_count", 0)),
		int(index.get("symbol_count", 0)),
		int(index.get("reference_count", 0)),
		int(index.get("dependency_count", 0)),
	]) + (_t(" · partial index") if bool(index.get("truncated", false)) else "")


func _on_operation_failed(method: String, message: String) -> void:
	_snapshot_pending = false
	if method.begins_with("index."):
		_set_index_state("Failed", Color("d87979"))
	_set_status("%s: %s" % [method, message], Color("d87979"))


func _set_form_enabled(enabled_value: bool, readonly: bool = false) -> void:
	_scope.disabled = not enabled_value or readonly or not _selected_id.is_empty()
	_name_input.editable = enabled_value and not readonly and _selected_id.is_empty()
	_description_input.editable = enabled_value and not readonly
	_triggers_input.editable = enabled_value and not readonly
	_capabilities_input.editable = enabled_value and not readonly
	_instructions_input.editable = enabled_value and not readonly
	_enabled.disabled = not enabled_value
	_save_button.disabled = not enabled_value or readonly
	_delete_button.disabled = not enabled_value or readonly or _selected_id.is_empty()


func _select_scope(scope_value: String) -> void:
	for index in _scope.item_count:
		if str(_scope.get_item_metadata(index)) == scope_value:
			_scope.select(index)
			return


func _scope_label(scope_value: String) -> String:
	match scope_value:
		"builtin":
			return _t("Built-in")
		"user":
			return _t("Personal")
		_:
			return _t("Project")


func _split_lines(value: String) -> Array[String]:
	var result: Array[String] = []
	for line in value.replace(",", "\n").split("\n"):
		var normalized := str(line).strip_edges()
		if not normalized.is_empty() and not result.has(normalized):
			result.append(normalized)
	return result


func _join_string_array(value: Variant) -> String:
	if not value is Array:
		return ""
	var result: Array[String] = []
	for entry in value:
		result.append(str(entry))
	return "\n".join(result)


func _format_diagnostics(value: Variant) -> String:
	if not value is Array:
		return ""
	var lines: Array[String] = []
	for diagnostic_value in (value as Array).slice(0, 16):
		if not diagnostic_value is Dictionary:
			continue
		var diagnostic: Dictionary = diagnostic_value
		lines.append("%s: %s" % [
			str(diagnostic.get("path", "SKILL.md")),
			str(diagnostic.get("message", "")),
		])
	return "\n".join(lines)


func _set_status(key: String, color: Color) -> void:
	_status.text = _t(key)
	_status.add_theme_color_override("font_color", color)


func _set_index_state(key: String, color: Color) -> void:
	# New presentation nodes do not exist on a Dock instance retained by script hot reload.
	if not is_instance_valid(_index_state):
		return
	_index_state.text = _t(key)
	_index_state.add_theme_color_override("font_color", color)


func _t(message: String) -> String:
	return Localization.translate(message)
