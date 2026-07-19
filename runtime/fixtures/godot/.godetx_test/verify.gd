extends SceneTree


func _init() -> void:
	var target_script := load("res://scripts/agent_target.gd")
	if target_script == null or target_script.call("greeting") != "Hello from GodetX runtime":
		printerr("Script verification failed")
		quit(1)
		return
	var packed_scene := load("res://main.tscn") as PackedScene
	if packed_scene == null:
		printerr("Scene load failed")
		quit(1)
		return
	var instance := packed_scene.instantiate()
	var label := instance.get_node_or_null("AgentLabel") as Label
	if label == null or label.text != "Scene edited by GodetX":
		printerr("Scene verification failed")
		instance.free()
		quit(1)
		return
	instance.free()
	print("GODETX_E2E_OK")
	quit(0)
