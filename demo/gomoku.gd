extends Node2D
## 五子棋棋盘：绘制棋盘、处理落子、判定胜负。

const GRID_SIZE: int = 15          # 15x15 标准棋盘
const CELL_SIZE: float = 40.0      # 每格像素
const MARGIN: float = 40.0         # 棋盘外边距
const PIECE_RADIUS: float = 16.0   # 棋子半径

const EMPTY: int = 0
const BLACK: int = 1
const WHITE: int = 2

var board: Array = []              # 二维数组，存放每个交叉点的状态
var current_player: int = BLACK    # 黑棋先手
var game_over: bool = false
var winner: int = EMPTY

@onready var status_label: Label = $StatusLabel
@onready var reset_button: Button = $ResetButton


func _ready() -> void:
	_reset_board()
	if reset_button:
		reset_button.pressed.connect(_reset_board)


func _reset_board() -> void:
	board = []
	for y in range(GRID_SIZE):
		var row: Array = []
		row.resize(GRID_SIZE)
		row.fill(EMPTY)
		board.append(row)
	current_player = BLACK
	game_over = false
	winner = EMPTY
	_update_status()
	queue_redraw()


func _unhandled_input(event: InputEvent) -> void:
	if game_over:
		return
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		var cell := _pos_to_cell(get_local_mouse_position())
		if cell.x >= 0 and _place_piece(cell.x, cell.y):
			get_viewport().set_input_as_handled()


func _place_piece(gx: int, gy: int) -> bool:
	if gx < 0 or gx >= GRID_SIZE or gy < 0 or gy >= GRID_SIZE:
		return false
	if board[gy][gx] != EMPTY:
		return false
	board[gy][gx] = current_player
	if _check_win(gx, gy, current_player):
		game_over = true
		winner = current_player
	else:
		current_player = WHITE if current_player == BLACK else BLACK
	_update_status()
	queue_redraw()
	return true


func _check_win(gx: int, gy: int, player: int) -> bool:
	# 四个方向：横、竖、两条斜线
	var directions := [Vector2i(1, 0), Vector2i(0, 1), Vector2i(1, 1), Vector2i(1, -1)]
	for dir in directions:
		var count := 1
		count += _count_direction(gx, gy, dir.x, dir.y, player)
		count += _count_direction(gx, gy, -dir.x, -dir.y, player)
		if count >= 5:
			return true
	return false


func _count_direction(gx: int, gy: int, dx: int, dy: int, player: int) -> int:
	var count := 0
	var nx := gx + dx
	var ny := gy + dy
	while nx >= 0 and nx < GRID_SIZE and ny >= 0 and ny < GRID_SIZE and board[ny][nx] == player:
		count += 1
		nx += dx
		ny += dy
	return count


func _cell_to_pos(gx: int, gy: int) -> Vector2:
	return Vector2(MARGIN + gx * CELL_SIZE, MARGIN + gy * CELL_SIZE)


func _pos_to_cell(pos: Vector2) -> Vector2i:
	var gx := int(round((pos.x - MARGIN) / CELL_SIZE))
	var gy := int(round((pos.y - MARGIN) / CELL_SIZE))
	if gx < 0 or gx >= GRID_SIZE or gy < 0 or gy >= GRID_SIZE:
		return Vector2i(-1, -1)
	# 只有点击点足够靠近交叉点才算有效
	if _cell_to_pos(gx, gy).distance_to(pos) > CELL_SIZE * 0.5:
		return Vector2i(-1, -1)
	return Vector2i(gx, gy)


func _update_status() -> void:
	if status_label == null:
		return
	if game_over:
		status_label.text = "%s 获胜！" % ("黑棋" if winner == BLACK else "白棋")
	else:
		status_label.text = "轮到：%s" % ("黑棋" if current_player == BLACK else "白棋")


func _draw() -> void:
	var board_px := (GRID_SIZE - 1) * CELL_SIZE
	var bg_rect := Rect2(Vector2.ZERO, Vector2(board_px + MARGIN * 2, board_px + MARGIN * 2))
	draw_rect(bg_rect, Color(0.86, 0.68, 0.42))  # 木色底

	var line_color := Color(0.15, 0.1, 0.05)
	for i in range(GRID_SIZE):
		var off := MARGIN + i * CELL_SIZE
		draw_line(Vector2(MARGIN, off), Vector2(MARGIN + board_px, off), line_color, 1.5)      # 横线
		draw_line(Vector2(off, MARGIN), Vector2(off, MARGIN + board_px), line_color, 1.5)      # 竖线

	# 星位（天元及四角）
	var star_points := [Vector2i(3, 3), Vector2i(11, 3), Vector2i(3, 11), Vector2i(11, 11), Vector2i(7, 7)]
	for sp in star_points:
		draw_circle(_cell_to_pos(sp.x, sp.y), 4.0, line_color)

	# 棋子
	for y in range(GRID_SIZE):
		for x in range(GRID_SIZE):
			var p: int = board[y][x]
			if p == EMPTY:
				continue
			var center := _cell_to_pos(x, y)
			var color := Color.BLACK if p == BLACK else Color.WHITE
			draw_circle(center, PIECE_RADIUS, color)
			draw_arc(center, PIECE_RADIUS, 0, TAU, 32, Color(0.1, 0.1, 0.1), 1.5)
