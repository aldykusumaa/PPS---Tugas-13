// [UPGRADED UPDATE / PATCH] WITH FAULT TOLERANCE
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

        // Mengembalikan respons sukses jika semua langkah aman
        res.status(200).json({
            success: true,
            message: `Status transaksi ID ${paymentId} berhasil diperbarui menjadi ${status}`,
            data: payment
        });

    } catch (error) {
        // Blok Catch: Menangani kegagalan internal tanpa membuat server mati (Fault Tolerance)
        console.error("Terjadi kegagalan internal sistem:", error.message);
        res.status(500).json({
            success: false,
            message: "Terjadi gangguan internal pada server komunikasi layanan. Silakan coba beberapa saat lagi."
        });
    }
});