package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	_ "github.com/mattn/go-sqlite3"
)

// --- 数据模型 ---

type Message struct {
	Type      string    `json:"type"` // "chat" 或 "count"
	Sender    string    `json:"sender"`
	Content   string    `json:"content"`
	Count     int       `json:"count"` // 当前在线人数
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

func (h *Hub) broadcastMessage(msg Message) {
    for client := range h.clients {
        select {
        case client.send <- msg:
        default:
            close(client.send)
            delete(h.clients, client)
        }
    }
}
func(h *Hub) run() {
    for {
        select {
        case client := <-h.register:
            h.mu.Lock()
            h.clients[client] = true
            count := len(h.clients)
            // 使用辅助函数，直接循环发送，不走通道
            h.broadcastMessage(Message{Type: "count", Count: count})
            h.mu.Unlock()
            log.Printf("【WS日志】新连接，当前在线: %d 人", count)

        case client := <-h.unregister:
            h.mu.Lock()
            if _, ok := h.clients[client]; ok {
                delete(h.clients, client)
                close(client.send)
            }
            count := len(h.clients)
            h.broadcastMessage(Message{Type: "count", Count: count})
            h.mu.Unlock()
            log.Printf("【WS日志】用户离开，当前在线: %d 人", count)

        case msg := <-h.broadcast:
            h.mu.Lock()
            h.broadcastMessage(msg)
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
		msg.Type = "chat"
		msg.CreatedAt = time.Now()
		// 消息入库
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

	// 根路径：登陆界面
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path!= "/" {
			// 处理根目录下的 style.css, index.css 等文件 
			http.FileServer(http.Dir(".")).ServeHTTP(w, r)
			return
		}
		log.Println("【访问日志】有人打开了登陆页面 (/)")
		http.ServeFile(w, r, "index.html") // 发送你的登陆界面
	})

	// 显式提供 components 文件夹服务 (用于 navigation.html) 
	http.Handle("/components/", http.StripPrefix("/components/", http.FileServer(http.Dir("./components"))))

	// 注册页面
	http.HandleFunc("/register.html", func(w http.ResponseWriter, r *http.Request) {
		log.Println("【访问日志】有人打开了注册页面")
		http.ServeFile(w, r, "register.html")
	})

	// 聊天室页面（需检查登录
	http.HandleFunc("/chat.html", func(w http.ResponseWriter, r *http.Request) {
		if _, err := r.Cookie("username"); err!= nil {
			log.Println("【拦截日志】未登陆用户尝试进入聊天室，踢回登陆页")
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		http.ServeFile(w, r, "chat.html")
	})

	// --- 接口路由 ---

	// 登录接口 
	http.HandleFunc("/api/login", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		u, p := r.FormValue("username"), r.FormValue("password")
		log.Printf("【登陆尝试】用户名: %s, 密码: %s", u, p)
		var savedPwd string
		err := db.QueryRow("SELECT password FROM users WHERE username=?", u).Scan(&savedPwd)
		if err == nil && savedPwd == p {
			// 成功：设置 Cookie 并跳转到 chat.html
			log.Printf("【登陆成功】欢迎回来, %s！正在跳转聊天室...", u)
			http.SetCookie(w, &http.Cookie{Name: "username", Value: u, Path: "/", MaxAge: 86400})
			http.Redirect(w, r, "/chat.html", http.StatusFound)
		} else {
			log.Printf("【登陆失败】用户名或密码不匹配")
			w.Write([]byte("用户名或密码错误"))
		}
	})

	// 注册接口
	http.HandleFunc("/api/register", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		u, p := r.FormValue("username"), r.FormValue("password")
		log.Printf("【注册请求】用户名: %s, 密码: %s", u, p)
		_, err := db.Exec("INSERT INTO users (username, password) VALUES (?,?)", u, p)
		if err!= nil {
			w.Write([]byte("注册失败: 用户名可能已存在"))
			return
		}
		log.Printf("【注册成功】用户 %s 已加入数据库，正在跳转登陆页...", u)
		http.Redirect(w, r, "/", http.StatusFound)
	})

	// WebSocket 接口
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("username")
		if err != nil {
			log.Printf("【WS拒绝】未找到登录Cookie: %v", err)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		
		conn, _ := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("【WS升级失败】: %v", err)
			return
		}
		client := &Client{hub: hub, conn: conn, send: make(chan Message, 256)}
		client.hub.register <- client

		// 自动加载最近 100 条消息
		rows, _ := db.Query("SELECT sender, content, created_at FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 100) ORDER BY id ASC")
		defer rows.Close()
		for rows.Next() {
			var m Message
			m.Type = "chat"
			rows.Scan(&m.Sender, &m.Content, &m.CreatedAt)
			client.send <- m
		}
		log.Printf("【WS连接成功】用户: %s", cookie.Value)

		go client.writePump()
		go client.readPump(db)
		_ = cookie
	})

	fmt.Println("-------------------------------------------")
	fmt.Println("🚀 聊天室后端已启动：http://localhost:8080")
	fmt.Println("   请在 Debian 终端观察日志输出")
	fmt.Println("-------------------------------------------")
	http.ListenAndServe(":8080", nil)
}
