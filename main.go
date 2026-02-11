package main

import (
	"database/sql"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	_ "github.com/mattn/go-sqlite3"
)

// --- 数据模型 ---

type Message struct {
	Sender    string    `json:"sender"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
}

// --- WebSocket 广播中心 ---

type Hub struct {
	clients    map[*Client]bool
	broadcast  chan Message
	register   chan *Client
	unregister chan *Client
	mu         sync.Mutex
}

func newHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan Message),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			h.mu.Unlock()
		case msg := <-h.broadcast:
			h.mu.Lock()
			for client := range h.clients {
				select {
				case client.send <- msg:
				default:
					close(client.send)
					delete(h.clients, client)
				}
			}
			h.mu.Unlock()
		}
	}
}

// --- WebSocket 客户端 ---

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan Message
}

func (c *Client) readPump(db *sql.DB) {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	for {
		var msg Message
		if err := c.conn.ReadJSON(&msg); err!= nil {
			break
		}
		msg.CreatedAt = time.Now()
		// 消息入库 [4]
		db.Exec("INSERT INTO messages (sender, content, created_at) VALUES (?,?,?)",
			msg.Sender, msg.Content, msg.CreatedAt)
		c.hub.broadcast <- msg
	}
}

func (c *Client) writePump() {
	defer c.conn.Close()
	for msg := range c.send {
		if err := c.conn.WriteJSON(msg); err!= nil {
			break
		}
	}
}

// --- 主程序与路由 ---

func main() {
	// 1. 初始化数据库 [4, 5]
	db, err := sql.Open("sqlite3", "./chat.db?_journal=WAL")
	if err!= nil {
		log.Fatal(err)
	}
	db.Exec(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT);`)
	db.Exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, content TEXT, created_at DATETIME);`)

	hub := newHub()
	go hub.run()

	// --- 页面路由 ---

	// 根路径：现在就是你的登陆界面
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path!= "/" {
			// 处理根目录下的 style.css, index.css 等文件 
			http.FileServer(http.Dir(".")).ServeHTTP(w, r)
			return
		}
		// 如果已经登录，直接跳到聊天室
		if _, err := r.Cookie("username"); err == nil {
			http.Redirect(w, r, "/chat.html", http.StatusFound)
			return
		}
		http.ServeFile(w, r, "index.html") // 发送你的登陆界面
	})

	// 显式提供 components 文件夹服务 (用于 navigation.html) [1, 6]
	http.Handle("/components/", http.StripPrefix("/components/", http.FileServer(http.Dir("./components"))))

	// 注册页面
	http.HandleFunc("/register.html", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "register.html")
	})

	// 聊天室页面（需检查登录） [2, 3]
	http.HandleFunc("/chat.html", func(w http.ResponseWriter, r *http.Request) {
		if _, err := r.Cookie("username"); err!= nil {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		http.ServeFile(w, r, "chat.html")
	})

	// --- 接口路由 ---

	// 登录接口 [7]
	http.HandleFunc("/api/login", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		u, p := r.FormValue("username"), r.FormValue("password")
		var savedPwd string
		err := db.QueryRow("SELECT password FROM users WHERE username=?", u).Scan(&savedPwd)
		if err == nil && savedPwd == p {
			// 成功：设置 Cookie 并跳转到 chat.html
			http.SetCookie(w, &http.Cookie{Name: "username", Value: u, Path: "/", MaxAge: 86400})
			http.Redirect(w, r, "/chat.html", http.StatusFound)
		} else {
			w.Write([]byte("用户名或密码错误"))
		}
	})

	// 注册接口
	http.HandleFunc("/api/register", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		u, p := r.FormValue("username"), r.FormValue("password")
		_, err := db.Exec("INSERT INTO users (username, password) VALUES (?,?)", u, p)
		if err!= nil {
			w.Write([]byte("注册失败: 用户名可能已存在"))
			return
		}
		http.Redirect(w, r, "/", http.StatusFound) // 注册完去登录
	})

	// WebSocket 接口 [8, 9]
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("username")
		if err!= nil { return }
		
		conn, _ := upgrader.Upgrade(w, r, nil)
		client := &Client{hub: hub, conn: conn, send: make(chan Message, 256)}
		client.hub.register <- client

		// 自动加载最近 100 条消息 [9, 10]
		rows, _ := db.Query("SELECT sender, content, created_at FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 100) ORDER BY id ASC")
		defer rows.Close()
		for rows.Next() {
			var m Message
			rows.Scan(&m.Sender, &m.Content, &m.CreatedAt)
			client.send <- m
		}

		go client.writePump()
		go client.readPump(db)
		_ = cookie
	})

	log.Println("服务启动：http://localhost:8080")
	http.ListenAndServe(":8080", nil)
}