require('dotenv').config(); // Load environment variables dari file .env
const express = require('express');
const mysql = require('mysql2/promise'); // Menggunakan promise interface

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// =========================================================================
// 1. MIDDLEWARE CORS (MENCEGAH BLOKIR AKSES UI BROWSER KLIEN)
// =========================================================================
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, PATCH, POST, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// =========================================================================
// 2. KONFIGURASI KONEKSI DATABASE MYSQL VIA CONNECTION POOL PROMISE
// =========================================================================
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// =========================================================================
// 3. [READ ALL / QUEUE] - Memuat Antrean Pembayaran Menunggu Verifikasi
// =========================================================================
app.get('/v1/verifications', async(req, res) => {
    try {
        const queryStr = "SELECT * FROM payments WHERE status_payment = 'Menunggu Verifikasi'";
        const [results] = await db.query(queryStr);
        return res.status(200).json({ success: true, message: "Berhasil memuat antrean pembayaran", data: results });
    } catch (err) {
        console.error("Error GET Verifications:", err.message);
        return res.status(500).json({ success: false, message: "Gagal mengambil data dari database MySQL." });
    }
});

// =========================================================================
// 4. [BULLETPROOF UPDATE / PATCH] - Sinkronisasi Orkestrasi Transaksi (UC15)
// =========================================================================
app.patch('/v1/payments/:id', async(req, res) => {
    try {
        const paymentId = parseInt(req.params.id);
        if (isNaN(paymentId)) {
            return res.status(400).json({ success: false, message: "Format ID transaksi tidak valid." });
        }

        const { status, reason } = req.body || {};
        if (!status) {
            return res.status(400).json({ success: false, message: "Parameter status verifikasi wajib diisi." });
        }

        // LANGKAH 1: Kueri pencarian data transaksi
        const [paymentResults] = await db.query('SELECT * FROM payments WHERE payment_id = ?', [paymentId]);

        if (!paymentResults || paymentResults.length === 0) {
            return res.status(404).json({ success: false, message: "Data transaksi pembayaran tidak ditemukan pada sistem." });
        }

        const currentPayment = paymentResults[0];

        // PROTEKSI DUPLICATE REQUEST (IDEMPOTENCY CHECK)
        if (currentPayment.status_payment === 'Berhasil' || currentPayment.status_payment === 'Ditolak') {
            return res.status(409).json({
                success: false,
                message: `Duplicate Request Dicegah! Transaksi ini sudah diproses sebelumnya dengan status: ${currentPayment.status_payment}`,
                data: currentPayment
            });
        }

        // LANGKAH 2: Manajemen Percabangan Keputusan Admin
        if (status === 'Ditolak') {
            const updateQuery = 'UPDATE payments SET status_payment = ?, reject_reason = ? WHERE payment_id = ?';
            await db.query(updateQuery, ['Ditolak', reason || 'Bukti transfer tidak valid/kabur', paymentId]);
            return res.status(200).json({
                success: true,
                message: `Status transaksi ID ${paymentId} sukses diperbarui menjadi DITOLAK.`,
                data: { payment_id: paymentId, status_payment: 'Ditolak', reject_reason: reason }
            });

        } else if (status === 'Berhasil') {
            // === IMPLEMENTASI DATABASE TRANSACTION (ACID COMPLIANCE) ===
            const connection = await db.getConnection(); // Mengambil koneksi eksklusif dari pool

            try {
                await connection.beginTransaction(); // Mulai mode Transaksi

                // Ambil referensi durasi hari dari spesifikasi paket
                const [packageResults] = await connection.query('SELECT duration_days FROM package_gym WHERE package_id = ?', [currentPayment.package_id]);
                if (!packageResults || packageResults.length === 0) {
                    throw new Error("Gagal mengambil data durasi paket gym atau spesifikasi paket tidak ditemukan.");
                }

                const durationDays = parseInt(packageResults[0].duration_days);
                if (isNaN(durationDays)) {
                    throw new Error("Format data durasi paket pada basis data tidak valid.");
                }

                // Eksekusi Pembaruan Status Transaksi menjadi Berhasil
                await connection.query('UPDATE payments SET status_payment = ? WHERE payment_id = ?', ['Berhasil', paymentId]);

                // Hitung tanggal kedaluwarsa baru (Akurasi Zona Waktu Lokal)
                const today = new Date();
                today.setDate(today.getDate() + durationDays);

                // Menyesuaikan waktu menjadi waktu lokal agar format YYYY-MM-DD tepat sesuai hari ini (misal di WITA)
                const offset = today.getTimezoneOffset() * 60000;
                const localDate = new Date(today.getTime() - offset);
                const formattedDate = localDate.toISOString().split('T')[0];

                // Orkestrasi pembaruan data status keanggotaan
                await connection.query('UPDATE members SET status_membership = ?, active_until = ? WHERE member_id = ?', ['Aktif', formattedDate, currentPayment.member_id]);

                await connection.commit(); // ✅ Simpan permanen semua kueri di atas jika tidak ada eror

                return res.status(200).json({
                    success: true,
                    message: `Status transaksi ID ${paymentId} BERHASIL diverifikasi lunas. Akun member ${currentPayment.member_id} otomatis aktif hingga ${formattedDate}.`,
                    data: {
                        payment_id: paymentId,
                        member_id: currentPayment.member_id,
                        status_payment: 'Berhasil',
                        membership_expires: formattedDate
                    }
                });

            } catch (transactionError) {
                await connection.rollback(); // ❌ Batalkan semua perubahan jika 1 kueri saja gagal
                throw transactionError; // Lempar ke blok catch utama untuk direkam
            } finally {
                connection.release(); // Selalu kembalikan koneksi ke dalam pool
            }

        } else {
            return res.status(400).json({ success: false, message: "Nilai parameter status tidak valid. Gunakan 'Berhasil' atau 'Ditolak'." });
        }

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Eror Sinkronus Terdeteksi atau Transaksi Dibatalkan!",
            Penyebab_Asli: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`PaymentService Gymove Terkoneksi ke MySQL via Promise Pool.`);
    console.log(`Server Berjalan di http://localhost:${PORT}`);
});