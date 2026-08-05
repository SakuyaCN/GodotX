extends Node2D

@onready var exit_button: Button = $Node2D/ExitButton

var a = []

func _ready():
	exit_button.pressed.connect(_on_exit_button_pressed)
	print(a[2])

func _on_exit_button_pressed():
	get_tree().quit()
