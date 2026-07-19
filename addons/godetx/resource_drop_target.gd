@tool
extends PanelContainer

signal resource_paths_dropped(paths: PackedStringArray)

var drop_enabled := true
var accepted_extensions := PackedStringArray()
var allow_multiple := true
var can_accept_paths := Callable()


func forward_drop_from(control: Control) -> void:
	if control == null:
		return
	control.set_drag_forwarding(
		Callable(),
		Callable(self, "can_drop_forwarded"),
		Callable(self, "drop_forwarded")
	)


func can_drop_forwarded(at_position: Vector2, data: Variant) -> bool:
	return _can_drop_data(at_position, data)


func drop_forwarded(at_position: Vector2, data: Variant) -> void:
	_drop_data(at_position, data)


static func paths_from_drop_data(data: Variant) -> PackedStringArray:
	var paths := PackedStringArray()
	if not data is Dictionary:
		return paths
	var payload := data as Dictionary
	if str(payload.get("type", "")) != "files":
		return paths
	var files_value: Variant = payload.get("files")
	if not (files_value is Array or files_value is PackedStringArray):
		return paths
	for file_value: Variant in files_value:
		var normalized := _normalize_project_file_path(file_value)
		if normalized.is_empty():
			return PackedStringArray()
		if not paths.has(normalized):
			paths.append(normalized)
	return paths


func _can_drop_data(_at_position: Vector2, data: Variant) -> bool:
	if not drop_enabled:
		return false
	return _accepts_paths(paths_from_drop_data(data))


func _drop_data(_at_position: Vector2, data: Variant) -> void:
	if not drop_enabled:
		return
	var paths := paths_from_drop_data(data)
	if _accepts_paths(paths):
		resource_paths_dropped.emit(paths)


func _accepts_paths(paths: PackedStringArray) -> bool:
	if paths.is_empty() or (not allow_multiple and paths.size() != 1):
		return false
	if not accepted_extensions.is_empty():
		for path: String in paths:
			if not _has_accepted_extension(path):
				return false
	if can_accept_paths.is_valid():
		return bool(can_accept_paths.call(paths))
	return true


func _has_accepted_extension(path: String) -> bool:
	var extension := path.get_extension().to_lower()
	for accepted_value: String in accepted_extensions:
		var accepted := accepted_value.strip_edges().trim_prefix(".").to_lower()
		if not accepted.is_empty() and extension == accepted:
			return true
	return false


static func _normalize_project_file_path(value: Variant) -> String:
	if not (value is String or value is StringName):
		return ""
	var path := str(value).strip_edges().replace("\\", "/")
	if not path.begins_with("res://"):
		return ""
	var relative := path.trim_prefix("res://")
	if relative.is_empty() or relative.ends_with("/"):
		return ""
	var segments := relative.split("/", true)
	for segment: String in segments:
		if segment.is_empty() or segment == "." or segment == "..":
			return ""
	var normalized := "res://%s" % "/".join(segments)
	if normalized != path or not FileAccess.file_exists(normalized):
		return ""
	if DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(normalized)):
		return ""
	return normalized
