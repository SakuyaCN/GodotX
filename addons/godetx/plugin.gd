@tool
extends EditorPlugin

const DockContent := preload("res://addons/godetx/godetx_dock.gd")
const ImageXContent := preload("res://addons/godetx/imagex_dock.gd")
const SkillXContent := preload("res://addons/godetx/skillx_dock.gd")
const EditorGameDebugger := preload("res://addons/godetx/editor_game_debugger.gd")
const Localization := preload("res://addons/godetx/localization.gd")
const GODETX_MARK := preload("res://addons/godetx/icons/godotx-mark.png")
const RUNTIME_PROBE_NAME := "GodotXRuntimeProbe"
const LEGACY_RUNTIME_PROBE_NAME := "GodetXRuntimeProbe"
const RUNTIME_PROBE_PATH := "res://addons/godetx/runtime_probe.gd"
const RUNTIME_PROBE_SETTING := "autoload/%s" % RUNTIME_PROBE_NAME
const LEGACY_RUNTIME_PROBE_SETTING := "autoload/%s" % LEGACY_RUNTIME_PROBE_NAME

var _dock: EditorDock
var _content: Control
var _image_dock: EditorDock
var _image_content: Control
var _skill_dock: EditorDock
var _skill_content: Control
var _game_debugger
var _owns_runtime_probe := false
var _runtime_probe_available := false
var _runtime_probe_error := ""


func _enter_tree() -> void:
	if DisplayServer.get_name() == "headless":
		if (
			OS.get_environment("GODOTX_VERIFY_EDITOR_SAVE") == "1"
			or OS.get_environment("GODETX_VERIFY_EDITOR_SAVE") == "1"
		):
			call_deferred("_verify_editor_save")
		return
	Localization.install(get_editor_interface())
	_configure_runtime_probe()
	_game_debugger = EditorGameDebugger.new(
		get_editor_interface(),
		_runtime_probe_available,
		_runtime_probe_error
	)
	add_debugger_plugin(_game_debugger)
	_dock = EditorDock.new()
	_dock.set_translation_domain(Localization.DOMAIN)
	_dock.title = "GodotX"
	_dock.layout_key = "GodetX"
	_dock.dock_icon = GODETX_MARK
	_dock.force_show_icon = true
	_dock.set("global", true)
	_dock.default_slot = EditorDock.DOCK_SLOT_RIGHT_BR
	_content = DockContent.new()
	_content.set_translation_domain(Localization.DOMAIN)
	_content.set("editor_interface", get_editor_interface())
	_content.set("editor_undo_redo", get_undo_redo())
	_content.set("editor_game_debugger", _game_debugger)
	_dock.add_child(_content)
	add_dock(_dock)

	_image_dock = EditorDock.new()
	_image_dock.set_translation_domain(Localization.DOMAIN)
	_image_dock.title = "ImageX"
	_image_dock.layout_key = "ImageX"
	_image_dock.dock_icon = GODETX_MARK
	_image_dock.force_show_icon = true
	_image_dock.set("global", true)
	_image_dock.default_slot = EditorDock.DOCK_SLOT_RIGHT_BR
	_image_content = ImageXContent.new()
	_image_content.set_translation_domain(Localization.DOMAIN)
	_image_content.set("editor_interface", get_editor_interface())
	_image_content.set("godetx_dock", _content)
	_image_dock.add_child(_image_content)
	add_dock(_image_dock)

	_skill_dock = EditorDock.new()
	_skill_dock.set_translation_domain(Localization.DOMAIN)
	_skill_dock.title = "SkillX"
	_skill_dock.layout_key = "SkillX"
	_skill_dock.dock_icon = GODETX_MARK
	_skill_dock.force_show_icon = true
	_skill_dock.set("global", true)
	_skill_dock.default_slot = EditorDock.DOCK_SLOT_RIGHT_BR
	_skill_content = SkillXContent.new()
	_skill_content.set_translation_domain(Localization.DOMAIN)
	_skill_content.set("godetx_dock", _content)
	_skill_dock.add_child(_skill_content)
	add_dock(_skill_dock)


func _exit_tree() -> void:
	if _skill_content:
		_skill_content.shutdown()
	if _skill_dock:
		remove_dock(_skill_dock)
		_skill_dock.queue_free()
	_skill_dock = null
	_skill_content = null
	if _image_content:
		_image_content.shutdown()
	if _image_dock:
		remove_dock(_image_dock)
		_image_dock.queue_free()
	_image_dock = null
	_image_content = null
	if _content:
		_content.shutdown()
	if _dock:
		remove_dock(_dock)
		_dock.queue_free()
	_dock = null
	_content = null
	if _game_debugger != null:
		remove_debugger_plugin(_game_debugger)
	_game_debugger = null
	_remove_owned_runtime_probe()
	Localization.uninstall()


func _run_scene(scene: String, args: PackedStringArray) -> PackedStringArray:
	if _game_debugger == null:
		return args
	return _game_debugger.decorate_run_args(scene, args)


func _configure_runtime_probe() -> void:
	_owns_runtime_probe = false
	_runtime_probe_available = false
	_runtime_probe_error = ""
	_remove_legacy_runtime_probe()
	if ProjectSettings.has_setting(RUNTIME_PROBE_SETTING):
		var existing_path := _normalize_autoload_path(
			str(ProjectSettings.get_setting(RUNTIME_PROBE_SETTING, ""))
		)
		if existing_path == RUNTIME_PROBE_PATH:
			_runtime_probe_available = true
			_owns_runtime_probe = true
		else:
			_runtime_probe_error = (
				"The autoload name %s is already used by %s"
				% [RUNTIME_PROBE_NAME, existing_path]
			)
		return
	add_autoload_singleton(RUNTIME_PROBE_NAME, RUNTIME_PROBE_PATH)
	var installed_path := _normalize_autoload_path(
		str(ProjectSettings.get_setting(RUNTIME_PROBE_SETTING, ""))
	)
	_runtime_probe_available = installed_path == RUNTIME_PROBE_PATH
	_owns_runtime_probe = _runtime_probe_available
	if not _runtime_probe_available:
		_runtime_probe_error = "Could not register the GodotX runtime probe autoload"


func _remove_legacy_runtime_probe() -> void:
	if not ProjectSettings.has_setting(LEGACY_RUNTIME_PROBE_SETTING):
		return
	var legacy_path := _normalize_autoload_path(
		str(ProjectSettings.get_setting(LEGACY_RUNTIME_PROBE_SETTING, ""))
	)
	# Only migrate the historical GodetX entry when it is exactly this plugin's
	# probe. A project-owned autoload with that old name must remain untouched.
	if legacy_path == RUNTIME_PROBE_PATH:
		remove_autoload_singleton(LEGACY_RUNTIME_PROBE_NAME)


func _remove_owned_runtime_probe() -> void:
	if not _owns_runtime_probe:
		return
	if ProjectSettings.has_setting(RUNTIME_PROBE_SETTING):
		var existing_path := _normalize_autoload_path(
			str(ProjectSettings.get_setting(RUNTIME_PROBE_SETTING, ""))
		)
		if existing_path == RUNTIME_PROBE_PATH:
			remove_autoload_singleton(RUNTIME_PROBE_NAME)
	_owns_runtime_probe = false
	_runtime_probe_available = false


static func _normalize_autoload_path(value: String) -> String:
	var normalized := value.trim_prefix("*").strip_edges().replace("\\", "/")
	if not normalized.begins_with("uid://"):
		return normalized
	var resource_id := ResourceUID.text_to_id(normalized)
	if resource_id < 0:
		return normalized
	var resolved_path := ResourceUID.get_id_path(resource_id).replace("\\", "/")
	if not resolved_path.is_empty():
		return resolved_path
	var expected_id := ResourceLoader.get_resource_uid(RUNTIME_PROBE_PATH)
	return RUNTIME_PROBE_PATH if expected_id == resource_id else normalized


func _verify_editor_save() -> void:
	var content := DockContent.new()
	content.editor_interface = get_editor_interface()
	content.editor_undo_redo = get_undo_redo()
	var succeeded: bool = content._save_editor_files()
	content.free()
	if succeeded:
		print("GODETX_EDITOR_SAVE_OK")
	else:
		printerr("GODETX_EDITOR_SAVE_FAILED")
	get_tree().quit(0 if succeeded else 1)
