@tool
class_name GodetXVisualCapture
extends RefCounted

const MAX_PENDING_PREVIEWS := 16

var editor_interface: EditorInterface
var attachment_store
var _pending_previews: Dictionary = {}
var _next_preview_id := 0


func _init(value: EditorInterface = null, store_value = null) -> void:
	editor_interface = value
	attachment_store = store_value


func configure(value: EditorInterface, store_value) -> void:
	editor_interface = value
	attachment_store = store_value


func import_project_resource(path: String, completed: Callable) -> void:
	if not completed.is_valid():
		return
	if editor_interface == null or attachment_store == null:
		completed.call(_error("Editor visual capture is unavailable"))
		return
	var normalized := normalize_project_resource_path(path)
	if not bool(normalized.get("ok", false)):
		completed.call(normalized)
		return
	var resource_path := str(normalized.get("path", ""))
	if not ResourceLoader.exists(resource_path):
		completed.call(_error("Project resource does not exist: %s" % resource_path))
		return
	var resource: Resource = ResourceLoader.load(resource_path)
	if resource == null:
		completed.call(_error("Project resource could not be loaded: %s" % resource_path))
		return
	if resource is Texture2D:
		completed.call(attachment_store.import_texture(
			resource as Texture2D,
			"project_resource",
			resource_path.get_file()
		))
		return
	if _pending_previews.size() >= MAX_PENDING_PREVIEWS:
		completed.call(_error("Too many project previews are pending"))
		return
	var previewer: EditorResourcePreview = editor_interface.get_resource_previewer()
	if previewer == null:
		completed.call(_error("The editor resource previewer is unavailable"))
		return
	_next_preview_id += 1
	var request_id := "preview_%s_%d" % [str(Time.get_ticks_usec()), _next_preview_id]
	_pending_previews[request_id] = {
		"path": resource_path,
		"completed": completed,
	}
	previewer.queue_resource_preview(
		resource_path,
		self,
		&"_on_resource_preview_ready",
		request_id
	)


func capture_editor_viewport(kind: String, viewport_index: int, completed: Callable) -> void:
	if not completed.is_valid():
		return
	if editor_interface == null or attachment_store == null:
		completed.call(_error("Editor visual capture is unavailable"))
		return
	var normalized_kind := kind.strip_edges().to_lower()
	if normalized_kind != "2d" and normalized_kind != "3d":
		completed.call(_error("Editor viewport kind must be 2d or 3d"))
		return
	if viewport_index < 0 or viewport_index > 3:
		completed.call(_error("3D editor viewport index must be between 0 and 3"))
		return
	var viewport: SubViewport
	if normalized_kind == "2d":
		viewport = editor_interface.get_editor_viewport_2d()
	else:
		viewport = editor_interface.get_editor_viewport_3d(viewport_index)
	if viewport == null or not is_instance_valid(viewport) or viewport.size.x <= 0 or viewport.size.y <= 0:
		completed.call(_error("Editor viewport is unavailable or has no visible size"))
		return
	await RenderingServer.frame_post_draw
	if viewport == null or not is_instance_valid(viewport):
		completed.call(_error("Editor viewport closed before capture completed"))
		return
	var texture: ViewportTexture = viewport.get_texture()
	if texture == null:
		completed.call(_error("Editor viewport texture is unavailable"))
		return
	var image: Image = texture.get_image()
	if image == null or image.is_empty():
		completed.call(_error("Editor viewport returned an empty image"))
		return
	var root: Node = editor_interface.get_edited_scene_root()
	var scene_id := ""
	var scene_path := ""
	if root != null and is_instance_valid(root):
		scene_id = "scene_%s" % str(root.get_instance_id())
		scene_path = str(root.scene_file_path)
	var source := "editor_viewport"
	var display_name := "%s viewport.png" % normalized_kind.to_upper()
	completed.call(attachment_store.import_image(
		image,
		source,
		display_name,
		"high",
		{
			"scene_id": scene_id,
			"scene_path": scene_path,
			"captured_at_ms": int(Time.get_unix_time_from_system() * 1000.0),
			"viewport_width": viewport.size.x,
			"viewport_height": viewport.size.y,
		}
	))


func _on_resource_preview_ready(
	path: String,
	preview: Texture2D,
	thumbnail_preview: Texture2D,
	userdata: Variant
) -> void:
	var request_id := str(userdata)
	var pending_value: Variant = _pending_previews.get(request_id)
	_pending_previews.erase(request_id)
	if not pending_value is Dictionary:
		return
	var pending: Dictionary = pending_value
	var completed_value: Variant = pending.get("completed")
	if not completed_value is Callable or not (completed_value as Callable).is_valid():
		return
	var completed: Callable = completed_value
	var selected_preview: Texture2D = preview if preview != null else thumbnail_preview
	if selected_preview == null:
		completed.call(_error("The editor could not generate a preview for %s" % path))
		return
	completed.call(attachment_store.import_texture(
		selected_preview,
		"project_resource",
		str(pending.get("path", path)).get_file()
	))


static func normalize_project_resource_path(value: String) -> Dictionary:
	var path := value.strip_edges().replace("\\", "/")
	if path.is_empty():
		return _error("Project resource path is required")
	if not path.begins_with("res://"):
		path = "res://%s" % path.trim_prefix("/")
	if path.length() > 1024 or path.substr(6).contains("//"):
		return _error("Project resource path is invalid")
	var relative := path.trim_prefix("res://")
	for segment in relative.split("/", true):
		if segment.is_empty() or segment == "." or segment == "..":
			return _error("Project resource path contains an invalid segment")
	return {"ok": true, "path": path}
static func _error(message: String) -> Dictionary:
	return {"ok": false, "error": message}
