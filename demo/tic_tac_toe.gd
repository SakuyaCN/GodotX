extends Control

## 简单的井字棋棋盘：3x3 按钮网格，X / O 轮流落子，自动判定胜负并可重开。

const CELL_SIZE := 120
const CELL_GAP := 8

var _board: Array[String] = []
var _current_player := "X"
var _game_over := false
var _cells: Array[Button] = []

@onready var _status_label: Label = $VBox/Status
@onready var _grid: GridContainer = $VBox/Grid
@onready var _restart_button: Button = $VBox/Restart


func _ready() -> void:
	_grid.columns = 3
	_grid.add_theme_constant_override("h_separation", CELL_GAP)
	_grid.add_theme_constant_override("v_separation", CELL_GAP)

	for i in range(9):
		var cell := Button.new()
		cell.custom_minimum_size = Vector2(CELL_SIZE, CELL_SIZE)
		cell.add_theme_font_size_override("font_size", 64)
		cell.focus_mode = Control.FOCUS_NONE
		cell.pressed.connect(_on_cell_pressed.bind(i))
		_grid.add_child(cell)
		_cells.append(cell)

	_restart_button.pressed.connect(_reset_board)
	_reset_board()


func _on_cell_pressed(index: int) -> void:
	if _game_over or _board[index] != "":
		return

	_board[index] = _current_player
	_cells[index].text = _current_player

	var winner := _get_winner()
	if winner != "":
		_status_label.text = "玩家 %s 获胜！" % winner
		_game_over = true
	elif not _board.has(""):
		_status_label.text = "平局！"
		_game_over = true
	else:
		_current_player = "O" if _current_player == "X" else "X"
		_status_label.text = "轮到玩家 %s" % _current_player


func _get_winner() -> String:
	const LINES := [
		[0, 1, 2], [3, 4, 5], [6, 7, 8],
		[0, 3, 6], [1, 4, 7], [2, 5, 8],
		[0, 4, 8], [2, 4, 6],
	]
	for line in LINES:
		var a: String = _board[line[0]]
		if a != "" and a == _board[line[1]] and a == _board[line[2]]:
			return a
	return ""


func _reset_board() -> void:
	_board = ["", "", "", "", "", "", "", "", ""]
	_current_player = "X"
	_game_over = false
	for cell in _cells:
		cell.text = ""
	_status_label.text = "轮到玩家 %s" % _current_player
