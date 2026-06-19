const express = require('express');
const mysql = require('mysql2');
const app = express();
const PORT = 3000;

app.use(express.json());

// 1. MIDDLEWARE CORS (HAK AKSES JARINGAN AGAR BROWSER TIDAK BLOCKED)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, PATCH, POST, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// 2. KONFIGURASI KONEKSI DATABASE MYSQL (XAMPP)
const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'fitness_center',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 3. Mengambil Data Antrean Verifikasi untuk Admin
app.get('/v1/verifications', (req, res) => {
    const queryStr = "SELECT * FROM payments WHERE status_payment = 'Menunggu Verifikasi'";
    db.query(queryStr, (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, message: "Gagal mengambil data dari database MySQL." });
        }
        res.status(200).json({ success: true, message: "Berhasil memuat antrean pembayaran", data: results });
    });
});

// 4. [UPGRADED UPDATE / PATCH] - End-point Utama Tanggung Jawab
app.patch('/v1/payments/:id', (req, res) => {
    try {
        const paymentId = parseInt(req.params.id);
        const { status, reason } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, message: "Parameter status verifikasi wajib diisi." });
        }

        // 1. Mencegah Duplicate Request
        db.query('SELECT * FROM payments WHERE payment_id = ?', [paymentId], (err, paymentResults) => {
            if (err) return res.status(500).json({ success: false, message: "Database Error saat mencari data." });

            if (paymentResults.length === 0) {
                return res.status(404).json({ success: false, message: "Data transaksi pembayaran tidak ditemukan." });
            }

            const currentPayment = paymentResults[0];

            // PROTEKSI DUPLICATE REQUEST
            if (currentPayment.status_payment === 'Berhasil' || currentPayment.status_payment === 'Ditolak') {
                return res.status(409).json({
                    success: false,
                    message: `Duplicate Request Dicegah! Transaksi ini sudah diproses sebelumnya dengan status: ${currentPayment.status_payment}`,
                    data: currentPayment
                });
            }

            // LANGKAH 2: Eksekusi Logika Berdasarkan Keputusan Admin
            if (status === 'Ditolak') {
                // Skenario Verifikasi Ditolak
                const updateQuery = 'UPDATE payments SET status_payment = ?, reject_reason = ? WHERE payment_id = ?';
                db.query(updateQuery, ['Ditolak', reason || 'Bukti transfer tidak valid/kabur', paymentId], (err) => {
                    if (err) return res.status(500).json({ success: false, message: "Gagal memperbarui status penolakan di database." });

                    return res.status(200).json({
                        success: true,
                        message: `Status transaksi ID ${paymentId} sukses diperbarui menjadi DITOLAK. Notifikasi kegagalan dikirim ke member.`,
                        data: { payment_id: paymentId, status_payment: 'Ditolak', reject_reason: reason }
                    });
                });

            } else if (status === 'Berhasil') {
                // Skenario Verifikasi Disetujui (Orkestrasi Antar Tabel MySQL)
                db.query('SELECT duration_days FROM package_gym WHERE package_id = ?', [currentPayment.package_id], (err, packageResults) => {
                    if (err || packageResults.length === 0) {
                        return res.status(500).json({ success: false, message: "Gagal mengambil data durasi paket gym." });
                    }

                    const durationDays = packageResults[0].duration_days;

                    // Update status transaksi menjadi 'Berhasil'
                    db.query('UPDATE payments SET status_payment = ? WHERE payment_id = ?', ['Berhasil', paymentId], (err) => {
                        if (err) return res.status(500).json({ success: false, message: "Gagal meng-update tabel pembayaran." });

                        // Hitung tanggal kedaluwarsa baru (Masa aktif sekarang + jumlah hari durasi paket)
                        const today = new Date();
                        today.setDate(today.getDate() + durationDays);
                        const formattedDate = today.toISOString().split('T')[0]; // Format YYYY-MM-DD

                        // Update status keanggotaan dan tanggal berakhir di tabel members
                        db.query('UPDATE members SET status_membership = ?, active_until = ? WHERE member_id = ?', ['Aktif', formattedDate, currentPayment.member_id], (err) => {
                            if (err) return res.status(500).json({ success: false, message: "Gagal mengaktifkan status keanggotaan member di database." });

                            // Respons Sukses Utama Berhasil diorkestrasi
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
                        });
                    });
                });
            } else {
                return res.status(400).json({ success: false, message: "Nilai parameter status tidak valid. Gunakan 'Berhasil' atau 'Ditolak'." });
            }
        });
    } catch (error) {
        console.error("Internal Crash System Protected:", error.message);
        res.status(500).json({ success: false, message: "Terjadi gangguan komunikasi internal server (Fault Tolerance Active)." });
    }
});

app.listen(PORT, () => {
    console.log(`PaymentService Terkoneksi ke MySQL. Berjalan di http://localhost:${PORT}`);
});