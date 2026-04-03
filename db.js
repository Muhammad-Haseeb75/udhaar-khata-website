const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to database:', err);
    } else {
        console.log('Connected to SQLite database.');
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        // Users Table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'shopkeeper'
        )`, () => {
             db.run(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'shopkeeper'`, (err) => {
                 // Ignore if already exists
             });
        });

        // Customers Table
        db.run(`CREATE TABLE IF NOT EXISTS customers (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL DEFAULT 1,
            display_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`, () => {
             db.run(`ALTER TABLE customers ADD COLUMN user_id INTEGER DEFAULT 1`, (err) => {
                 // Column might already exist
             });
        });

        // Transactions Table
        db.run(`CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            cust_id TEXT NOT NULL,
            type TEXT NOT NULL,
            amount REAL NOT NULL,
            desc TEXT NOT NULL,
            date DATETIME DEFAULT CURRENT_TIMESTAMP,
            deadline DATETIME,
            FOREIGN KEY (cust_id) REFERENCES customers(id)
        )`, () => {
            // Add column to existing table just in case it already exists locally
            db.run(`ALTER TABLE transactions ADD COLUMN deadline DATETIME`, (err) => {
                // Ignore errors (column likely already exists)
            });
        });

        console.log('Database tables initialized.');
    });
}

// Ensure the db module exports the database instance
module.exports = db;
