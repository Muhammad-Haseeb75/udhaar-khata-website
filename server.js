const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'your-super-secret-jwt-key-change-in-prod'; // Keep this safe in real apps

// ─── WHATSAPP NOTIFICATION SETUP (Twilio Example) ───
// In a real application, you would use a service like Twilio to send automated WhatsApp messages.
// const twilio = require('twilio');
// const client = new twilio('AC_YOUR_ACCOUNT_SID', 'YOUR_AUTH_TOKEN');
// const twilioWhatsAppNumber = 'whatsapp:+14155238886'; // Twilio sandbox number

function sendAutomatedWhatsAppReminder(customerName, customerPhone, amountOwed) {
    console.log(`\n[CRON JOB] 🔔 Sending automated WhatsApp reminder to ${customerName} (${customerPhone}). Amount: ${amountOwed}`);
    /* 
    // Example Twilio Implementation:
    client.messages.create({
        body: `Hi ${customerName}, this is an automated reminder from Udhar Khata. Your payment of ₨${amountOwed} is due tomorrow!`,
        from: twilioWhatsAppNumber,
        to: `whatsapp:${customerPhone.replace(/^0/, '+92')}` // Assuming Pakistani numbers
    }).then(message => console.log(message.sid)).catch(err => console.error(err));
    */
}

// ─── DAILY CRON JOB FOR REMINDERS ───
// This job runs every day at 10:00 AM
cron.schedule('0 10 * * *', () => {
    console.log('Running daily deadline check...');
    
    // Find customers who have a deadline exactly tomorrow and still owe money
    const query = `
        SELECT c.id, c.name, c.phone, 
            COALESCE(SUM(CASE WHEN t.type = 'maine-diye' THEN t.amount ELSE 0 END), 0) as total_given,
            COALESCE(SUM(CASE WHEN t.type = 'maine-liye' THEN t.amount ELSE 0 END), 0) as total_received
        FROM customers c
        JOIN transactions t ON c.id = t.cust_id
        WHERE t.type = 'maine-diye' 
          AND t.deadline IS NOT NULL 
          AND DATE(t.deadline) = DATE('now', '+1 day', 'localtime')
        GROUP BY c.id
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error("Cron Job Error:", err);
            return;
        }
        
        rows.forEach(c => {
            const balance = c.total_given - c.total_received;
            if (balance > 0) {
                sendAutomatedWhatsAppReminder(c.name, c.phone, balance);
            }
        });
    });
});

// Middleware
app.use(cors());
app.use(express.json());
// Serve static frontend files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTHENTICATION SETUP (Demo Admin) ───
// For our demo, we'll ensure an admin user exists.
async function setupAdmin() {
    db.get("SELECT * FROM users WHERE username = 'haseeb'", async (err, row) => {
        if (!row) {
            const hash = await bcrypt.hash('123456', 10);
            db.run("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ['haseeb', hash, 'superadmin']);
            console.log("Created master super admin user (haseeb / 123456)");
        }
    });
}
setupAdmin();

// ─── AUTH API ───

// ─── SUPER ADMIN API ───
function superAdminMiddleware(req, res, next) {
    if (req.user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Super Admin access required.' });
    }
    next();
}

// Create a new shopkeeper account (Paid Registration)
app.post('/api/admin/shopkeepers', authMiddleware, superAdminMiddleware, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required.' });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        db.run("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", [username, hash, 'shopkeeper'], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'Username already taken.' });
                }
                return res.status(500).json({ error: err.message });
            }
            res.status(201).json({ message: 'Shopkeeper account created successfully!' });
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error during creation.' });
    }
});

app.get('/api/admin/shopkeepers', authMiddleware, superAdminMiddleware, (req, res) => {
    const sql = `
        SELECT u.id, u.username, COUNT(c.id) as customers_count
        FROM users u
        LEFT JOIN customers c ON c.user_id = u.id
        WHERE u.role = 'shopkeeper'
        GROUP BY u.id
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required.' });
    }

    db.get("SELECT * FROM users WHERE username = ? COLLATE NOCASE", [username], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: 'Invalid credentials.' });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role || 'shopkeeper' }, JWT_SECRET, { expiresIn: '1d' });
        res.json({ token, message: 'Logged in successfully', role: user.role || 'shopkeeper' });
    });
});

// Middleware to protect routes
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        req.user = decoded;
        next();
    });
}

// ─── CUSTOMERS API ───

// Get all customers with dynamic balances and trust scores
app.get('/api/customers', authMiddleware, (req, res) => {
    const query = `
        SELECT c.*, 
            COALESCE(SUM(CASE WHEN t.type = 'maine-diye' THEN t.amount ELSE 0 END), 0) as total_given,
            COALESCE(SUM(CASE WHEN t.type = 'maine-liye' THEN t.amount ELSE 0 END), 0) as total_received,
            
            -- Penalty for passing deadline without full payment
            -- Calculate days late
            COALESCE(MAX(
                CASE WHEN t.type = 'maine-diye' AND t.deadline IS NOT NULL AND DATE(t.deadline) < DATE('now', 'localtime') THEN 
                    CAST(julianday('now', 'localtime') - julianday(t.deadline) AS INTEGER)
                ELSE 0 END
            ), 0) as max_days_late,
            
            MAX(CASE WHEN t.type = 'maine-diye' AND t.deadline IS NOT NULL AND DATE(t.deadline) = DATE('now', '+1 day', 'localtime') THEN 1 ELSE 0 END) as due_tomorrow
            
        FROM customers c
        LEFT JOIN transactions t ON c.id = t.cust_id
        WHERE c.user_id = ?
        GROUP BY c.id
    `;
    db.all(query, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Compute balances and trust scores for API response
        const enhancedCustomers = rows.map(c => {
            const balance = c.total_given - c.total_received;
            
            // Base Trust Score starts at 100%
            let trustScore = 100;
            let trustLabel = 'EXCELLENT';
            
            if (c.total_given === 0 && c.total_received === 0) {
                trustLabel = 'NEW';
            } else if (balance > 0) {
                // They owe money.
                if (c.max_days_late > 0) {
                    // Late penalty: Deduct 5 points per day late.
                    trustScore = Math.max(0, 100 - (c.max_days_late * 5));
                } else {
                    // Not late yet, pending time is still active.
                    trustScore = 100;
                }
            } else {
                // Balance settled or we owe them
                trustScore = 100;
            }

            // Setup Labels
            if (c.total_given === 0 && c.total_received === 0) {
                trustLabel = 'NEW';
            } else if (trustScore === 100) {
                trustLabel = 'EXCELLENT';
            } else if (trustScore >= 50) {
                trustLabel = `GOOD (${c.max_days_late} Days Late)`;
            } else {
                trustLabel = `POOR (${c.max_days_late} Days Late)`;
            }

            return {
                id: c.id,
                displayId: c.display_id,
                name: c.name,
                phone: c.phone,
                address: c.address,
                balance,
                trustScore,
                trustLabel,
                dueTomorrow: c.due_tomorrow === 1 && balance > 0
            };
        });

        res.json(enhancedCustomers);
    });
});

// Create Customer
app.post('/api/customers', authMiddleware, (req, res) => {
    const { id, displayId, name, phone, address } = req.body;
    if (!id || !displayId || !name || !phone) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const sql = `INSERT INTO customers (id, user_id, display_id, name, phone, address) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(sql, [id, req.user.id, displayId, name, phone, address], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ message: 'Customer added successfully', id });
    });
});

// ─── TRANSACTIONS API ───

// Get transactions for a specific customer
app.get('/api/transactions/:custId', authMiddleware, (req, res) => {
    const custId = req.params.custId;
    db.all("SELECT id, cust_id as custId, type, amount, desc, date, deadline FROM transactions WHERE cust_id = ? ORDER BY date DESC", [custId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Create Transaction
app.post('/api/transactions', authMiddleware, (req, res) => {
    const { id, custId, type, amount, desc, date, deadline } = req.body;
    if (!id || !custId || !type || !amount || !desc) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const sql = `INSERT INTO transactions (id, cust_id, type, amount, desc, date, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [id, custId, type, amount, desc, date, deadline || null], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ message: 'Transaction added successfully' });
    });
});

// Delete Transaction
app.delete('/api/transactions/:id', authMiddleware, (req, res) => {
    db.run("DELETE FROM transactions WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Transaction deleted' });
    });
});

// Fallback to index.html for SPA routing (if needed)
app.use((req, res, next) => {
    if (req.method === 'GET' && req.accepts('html')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        next();
    }
});

// ─── SERVER START ───
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
