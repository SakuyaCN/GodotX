extends SceneTree


func _init() -> void:
	var packed := load("res://demo/main.tscn") as PackedScene
	if packed == null:
		printerr("Could not load demo/main.tscn")
		quit(1)
		return
	var instance := packed.instantiate()
	var title := instance.get_node_or_null("Title") as Label
	if title == null:
		printerr("Demo Title node is missing")
		instance.free()
		quit(1)
		return
	instance.free()
	print("GODETX_DEMO_OK")
	quit(0)
