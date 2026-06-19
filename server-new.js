const express = require('express');
const app = express();
const PORT = 3000;

// Middleware untuk membaca request body berbentuk JSON
app.use(express.json());

// Penyimpanan data sementara (In-Memory Array) pengganti database
let payments = [
    { id: 1, memberId: "M001", packageId: "PKG30", nominal: 150000, status: "Menunggu Verifikasi", reason: "" },
    { id: 2, memberId: "M002", packageId: "PKG90", nominal: 400000, status: "Berhasil", reason: "" }
];

// [READ ALL] - Menampilkan semua data transaksi pembayaran dengan Fault Tolerance
app.get('/v1/payments', (req, res) => {
    try {
        res.status(200).json({
            success: true,
            message: "Berhasil mengambil semua data pembayaran",
            data: payments
        });
    } catch (error) {
        console.error("Error pada GET /v1/payments:", error.message);
        res.status(500).json({ success: false, message: "Terjadi gangguan internal pada server." });
    }
});

// [CREATE] - Menambahkan data transaksi pembayaran baru dengan Fault Tolerance
app.post('/v1/payments', (req, res) => {
    try {
        const { memberId, packageId, nominal } = req.body;

        if (!memberId || !packageId || !nominal) {
            return res.status(400).json({ success: false, message: "Data input tidak lengkap" });
        }

        const newPayment = {
            id: payments.length + 1,
            memberId,
            packageId,
            nominal,
            status: "Menunggu Verifikasi",
            reason: ""
        };

        payments.push(newPayment);
        res.status(201).json({
            success: true,
            message: "Transaksi pembayaran baru berhasil ditambahkan",
            data: newPayment
        });
    } catch (error) {
        console.error("Error pada POST /v1/payments:", error.message);
        res.status(500).json({ success: false, message: "Terjadi gangguan internal pada server." });
    }
});

// [UPGRADED UPDATE / PATCH] - Mengubah status transaksi + Proteksi Duplicate Request & Service Unavailable
app.patch('/v1/payments/:id', (req, res) => {
    // Membuka blok try untuk menangkap potensi error sistem (Service Unavailable Handling)
    try {
        const paymentId = parseInt(req.params.id);
        const { status, reason } = req.body;

        // 1. Mencari data pembayaran berdasarkan ID
        const payment = payments.find(p => p.id === paymentId);

        if (!payment) {
            return res.status(404).json({ success: false, message: "Data pembayaran tidak ditemukan" });
        }

        // 2. Mencegah Duplicate Request (Idempotency Handling)
        // Jika status transaksi sudah 'Berhasil' atau 'Ditolak', jangan diproses ulang!
        if (payment.status === "Berhasil" || payment.status === "Ditolak") {
            return res.status(409).json({
                success: false,
                message: `Duplicate Request Terdeteksi! Transaksi ID ${paymentId} sudah berstatus ${payment.status} dan tidak bisa diubah lagi.`,
                data: payment
            });
        }

        // 3. Memperbarui data status jika lolos validasi ganda
        if (status) payment.status = status;
        if (reason !== undefined) payment.reason = reason;

        res.status(200).json({
            success: true,
            message: `Status transaksi ID ${paymentId} berhasil diperbarui menjadi ${status}`,
            data: payment
        });

    } catch (error) {
        // Blok Catch: Menangani kegagalan internal tanpa membuat server mati (Fault Tolerance)
        console.error("Terjadi kegagalan internal sistem pada PATCH:", error.message);
        res.status(500).json({
            success: false,
            message: "Terjadi gangguan internal pada server komunikasi layanan. Silakan coba beberapa saat lagi."
        });
    }
});

// [DELETE] - Menghapus data transaksi pembayaran dengan Fault Tolerance
app.delete('/v1/payments/:id', (req, res) => {
    try {
        const paymentId = parseInt(req.params.id);
        const paymentIndex = payments.findIndex(p => p.id === paymentId);

        if (paymentIndex === -1) {
            return res.status(404).json({ success: false, message: "Data pembayaran tidak ditemukan" });
        }

        payments.splice(paymentIndex, 1);
        res.status(200).json({
            success: true,
            message: `Data pembayaran dengan ID ${paymentId} berhasil dihapus`
        });
    } catch (error) {
        console.error("Error pada DELETE /v1/payments:", error.message);
        res.status(500).json({ success: false, message: "Terjadi gangguan internal pada server." });
    }
});

// Menjalankan server
app.listen(PORT, () => {
    console.log(`PaymentService (Secure Mode) berjalan di http://localhost:${PORT}`);
});