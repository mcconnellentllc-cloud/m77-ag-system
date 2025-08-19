// server.js - Complete backend server with SQLite for M77 AG
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve your HTML files from 'public' folder

// Create databases directory if it doesn't exist
const dbDir = path.join(__dirname, 'databases');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir);
}

// Initialize main database for M77 AG proposals
const db = new sqlite3.Database(path.join(dbDir, 'farming_proposals.db'));

// Create proposals table if it doesn't exist
db.run(`
    CREATE TABLE IF NOT EXISTS proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        operation_name TEXT NOT NULL,
        fields INTEGER,
        acres REAL,
        crop_type TEXT,
        start_date DATE,
        finish_date DATE,
        email TEXT NOT NULL,
        phone TEXT,
        services TEXT,
        subtotal TEXT,
        discount TEXT,
        total TEXT,
        status TEXT DEFAULT 'pending',
        notes TEXT
    )
`, (err) => {
    if (err) {
        console.error('Error creating proposals table:', err);
    } else {
        console.log('Proposals table ready');
    }
});

// Create services breakdown table for detailed tracking
db.run(`
    CREATE TABLE IF NOT EXISTS proposal_services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id INTEGER,
        service_name TEXT,
        rate TEXT,
        cost TEXT,
        FOREIGN KEY (proposal_id) REFERENCES proposals(id)
    )
`, (err) => {
    if (err) {
        console.error('Error creating services table:', err);
    } else {
        console.log('Services table ready');
    }
});

// API Routes

// Submit new proposal
app.post('/api/proposals', (req, res) => {
    const data = req.body;
    
    const sql = `
        INSERT INTO proposals (
            operation_name, fields, acres, crop_type, 
            start_date, finish_date, email, phone, 
            services, subtotal, discount, total
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const params = [
        data.operation,
        data.fields,
        data.acres,
        data.crop,
        data.startDate,
        data.finishDate,
        data.email,
        data.phone,
        JSON.stringify(data.services),
        data.subtotal,
        data.discount,
        data.total
    ];
    
    db.run(sql, params, function(err) {
        if (err) {
            console.error('Database error:', err);
            res.status(500).json({ error: err.message });
            return;
        }
        
        const proposalId = this.lastID;
        
        // Also insert individual services for better tracking
        if (data.services && data.services.length > 0) {
            data.services.forEach(service => {
                db.run(
                    'INSERT INTO proposal_services (proposal_id, service_name, rate, cost) VALUES (?, ?, ?, ?)',
                    [proposalId, service.name, service.rate, service.cost]
                );
            });
        }
        
        res.json({ 
            success: true, 
            id: proposalId,
            message: 'Proposal submitted successfully'
        });
    });
});

// Get all proposals (admin endpoint with password protection)
app.get('/api/proposals', (req, res) => {
    // UPDATED PASSWORD - Change 'M77admin2024!' to your own secure password
    const adminPassword = req.headers['x-admin-password'];
    if (adminPassword !== 'M77admin2024!') {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const sql = `
        SELECT * FROM proposals 
        ORDER BY timestamp DESC
    `;
    
    db.all(sql, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        // Parse services JSON for each proposal
        rows = rows.map(row => ({
            ...row,
            services: row.services ? JSON.parse(row.services) : []
        }));
        
        res.json(rows);
    });
});

// Get single proposal by ID
app.get('/api/proposals/:id', (req, res) => {
    const sql = 'SELECT * FROM proposals WHERE id = ?';
    
    db.get(sql, [req.params.id], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        if (!row) {
            res.status(404).json({ error: 'Proposal not found' });
            return;
        }
        
        row.services = row.services ? JSON.parse(row.services) : [];
        res.json(row);
    });
});

// Update proposal status (approve/reject/complete)
app.patch('/api/proposals/:id/status', (req, res) => {
    const { status, notes } = req.body;
    const sql = 'UPDATE proposals SET status = ?, notes = ? WHERE id = ?';
    
    db.run(sql, [status, notes, req.params.id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        res.json({ 
            success: true, 
            changes: this.changes 
        });
    });
});

// Delete proposal
app.delete('/api/proposals/:id', (req, res) => {
    // First delete related services
    db.run('DELETE FROM proposal_services WHERE proposal_id = ?', [req.params.id], (err) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        // Then delete the proposal
        db.run('DELETE FROM proposals WHERE id = ?', [req.params.id], function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            res.json({ 
                success: true, 
                deleted: this.changes 
            });
        });
    });
});

// Analytics endpoint - get summary statistics
app.get('/api/analytics', (req, res) => {
    const queries = {
        totalProposals: 'SELECT COUNT(*) as count FROM proposals',
        totalValue: 'SELECT SUM(CAST(REPLACE(REPLACE(total, "$", ""), ",", "") AS REAL)) as total FROM proposals',
        avgAcres: 'SELECT AVG(acres) as avg FROM proposals',
        topServices: `
            SELECT service_name, COUNT(*) as count 
            FROM proposal_services 
            GROUP BY service_name 
            ORDER BY count DESC 
            LIMIT 5
        `,
        recentProposals: `
            SELECT * FROM proposals 
            ORDER BY timestamp DESC 
            LIMIT 10
        `
    };
    
    const results = {};
    let completed = 0;
    const totalQueries = Object.keys(queries).length;
    
    Object.entries(queries).forEach(([key, sql]) => {
        db.all(sql, [], (err, rows) => {
            if (err) {
                console.error(`Error in ${key}:`, err);
                results[key] = null;
            } else {
                results[key] = rows.length === 1 && key !== 'topServices' && key !== 'recentProposals' 
                    ? rows[0] 
                    : rows;
            }
            
            completed++;
            if (completed === totalQueries) {
                res.json(results);
            }
        });
    });
});

// Export data as CSV
app.get('/api/export/csv', (req, res) => {
    const sql = 'SELECT * FROM proposals ORDER BY timestamp DESC';
    
    db.all(sql, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        // Create CSV content
        const headers = ['ID', 'Timestamp', 'Operation', 'Fields', 'Acres', 'Crop', 'Start Date', 'End Date', 'Email', 'Phone', 'Total', 'Status'];
        const csvContent = [
            headers.join(','),
            ...rows.map(row => [
                row.id,
                row.timestamp,
                `"${row.operation_name}"`,
                row.fields,
                row.acres,
                row.crop_type,
                row.start_date,
                row.finish_date,
                `"${row.email}"`,
                `"${row.phone || ''}"`,
                `"${row.total}"`,
                row.status
            ].join(','))
        ].join('\n');
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=proposals.csv');
        res.send(csvContent);
    });
});

// Integration with other databases
// Example: Connect to multiple SQLite databases for different projects
class DatabaseManager {
    constructor() {
        this.databases = {};
    }
    
    addDatabase(name, filename) {
        const dbPath = path.join(dbDir, filename);
        this.databases[name] = new sqlite3.Database(dbPath);
        console.log(`Connected to ${name} database`);
    }
    
    query(dbName, sql, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.databases[dbName]) {
                reject(new Error(`Database ${dbName} not found`));
                return;
            }
            
            this.databases[dbName].all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }
}

// Initialize database manager for multiple projects
const dbManager = new DatabaseManager();
dbManager.addDatabase('farming', 'farming_proposals.db');
// Add other project databases as needed:
// dbManager.addDatabase('inventory', 'inventory.db');
// dbManager.addDatabase('customers', 'customers.db');

// Endpoint to query across multiple databases
app.get('/api/integrated/search', async (req, res) => {
    const { query } = req.query;
    
    try {
        // Search across multiple databases
        const farmingResults = await dbManager.query('farming', 
            'SELECT * FROM proposals WHERE operation_name LIKE ? OR email LIKE ?',
            [`%${query}%`, `%${query}%`]
        );
        
        // Add results from other databases as needed
        // const inventoryResults = await dbManager.query('inventory', ...);
        
        res.json({
            farming: farmingResults,
            // inventory: inventoryResults,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`M77 AG System Started Successfully!`);
    console.log(`========================================`);
    console.log(`Server running on: http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
    console.log(`Database location: ${path.join(dbDir, 'farming_proposals.db')}`);
    console.log(`\nAPI Endpoints:`);
    console.log('POST   /api/proposals        - Submit new proposal');
    console.log('GET    /api/proposals        - Get all proposals (requires password)');
    console.log('GET    /api/proposals/:id    - Get single proposal');
    console.log('PATCH  /api/proposals/:id/status - Update proposal status');
    console.log('DELETE /api/proposals/:id    - Delete proposal');
    console.log('GET    /api/analytics        - Get analytics data');
    console.log('GET    /api/export/csv       - Export as CSV');
    console.log(`\nPress Ctrl+C to stop the server`);
    console.log(`========================================\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nClosing database connections...');
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Database connection closed.');
        process.exit(0);
    });
});