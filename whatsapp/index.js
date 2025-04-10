import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys"
import MAIN_LOGGER from 'pino'
import {writeLog, newline, readCount, writeCount} from "../log/index.js"

export default class Whatsapp {
    constructor() {
        this.logger = MAIN_LOGGER.default()
        this.logger.level = 'silent' // Bisa diubah ke silent atau error
        this.sock = null
        this.status = 0
        this.qr = null
        this.pairing = null
        this.count = 0

        // Konfigurasi auto delete
        this.autoDeleteEnabled = true                  // Aktifkan auto delete pesan periodik
        this.autoDeleteIntervalMinutes = 5             // Interval dalam menit
        this.autoDeleteVerificationEnabled = true        // Auto delete pesan verifikasi langsung
        // Kata kunci untuk mendeteksi pesan verifikasi (case-insensitive)
        this.verificationKeywords = ["verifikasi", "otp", "verification"]

        // Array untuk menyimpan pesan yang pending untuk dihapus
        this.pendingDeletion = []

        this.readCount()
        
        // Mulai timer auto delete jika fitur diaktifkan
        if(this.autoDeleteEnabled){
            // Cek tiap 1 menit, lalu cek apakah pesan sudah melebihi interval yang ditentukan
            setInterval(() => {
                let now = Date.now()
                // Ambil pesan dengan delay lebih dari autoDeleteIntervalMinutes
                let remaining = []
                this.pendingDeletion.forEach(async (pending) => {
                    if(now - pending.timestamp >= this.autoDeleteIntervalMinutes * 60000) {
                        try {
                            // Lakukan delete pesan
                            await this.sock.readMessages([pending.key])
                            await this.sock.chatModify({
                                clear: {
                                    messages: [{
                                        id: pending.key.id,
                                        fromMe: pending.key.fromMe,
                                        timestamp: pending.timestamp / 1000 // pastikan sesuai format (detik)
                                    }]
                                }
                            }, pending.jid, [])
                            this.count += 1
                            await writeCount(this.count)
                            await writeLog("Auto delete (periodik) - From: " + pending.jid)
                        } catch(e) {
                            await writeLog("Error auto deleting pesan: " + e)
                            remaining.push(pending)
                        }
                    } else {
                        remaining.push(pending)
                    }
                })
                this.pendingDeletion = remaining
            }, 60000) // pengecekan tiap 60 detik
        }
    }

    async readCount(){
        this.count = await readCount()
    }

    async WAConnect() {
        const { state, saveCreds } = await useMultiFileAuthState("creds")
        this.sock = makeWASocket.default({
            auth: state,
            logger: this.logger
        })

        this.sock.ev.on("creds.update", saveCreds)

        this.sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect } = update
            if (connection === "close") {
                const reconnect = lastDisconnect.error?.output?.payload?.statusCode !== DisconnectReason.loggedOut
                if (reconnect) {
                    this.WAConnect()
                }
                this.status = 0
                this.qr = null
                this.pairing = null
            }
            else if (connection === "open") {
                this.status = 3
                this.qr = null
                this.pairing = null
            }
            else {
                // Jika update mengandung QR code atau pairing code
                if(update.qr) {
                    this.status = 1
                    this.qr = update.qr
                    this.pairing = null
                }
                else if(update.pairingCode) {
                    this.status = 1
                    this.pairing = update.pairingCode
                    this.qr = null
                }
                else {
                    this.status = 3
                    this.qr = null
                    this.pairing = null
                }
            }
        })

        this.sock.ev.on("messages.upsert", async (m) => {
            let msgObj = m.messages[0]
            let isRevoked = msgObj.hasOwnProperty("message") ? msgObj.message.hasOwnProperty("protocolMessage") ? true : false : false
            // Proses hanya jika pesan bukan dari kita sendiri
            if (!msgObj.key.fromMe) {
                if (!isRevoked) {
                    let isMessage = msgObj.hasOwnProperty("message") ? true : false
                    let isImage = isMessage ? msgObj.message.hasOwnProperty("imageMessage") ? true : false : false
                    let from = msgObj.key.remoteJid
                    // Ambil pesan (caption untuk gambar atau text biasa)
                    let msg = ""
                    if(isMessage){
                        if(isImage){
                            msg = msgObj.message.imageMessage.caption || ""
                        } else if(msgObj.message.hasOwnProperty("conversation")){
                            msg = msgObj.message.conversation
                        } else if(msgObj.message.hasOwnProperty("extendedTextMessage")){
                            msg = msgObj.message.extendedTextMessage.text
                        }
                    }

                    // Cek untuk pesan dengan "wa.me/settings" dan hapus segera
                    let regexSettings = /wa\.me\/settings/gi;
                    if (regexSettings.test(msg)) {
                        await this.sock.readMessages([msgObj.key])
                        await this.sock.chatModify({
                            clear: {
                                messages: [{
                                    id: msgObj.key.id,
                                    fromMe: msgObj.key.fromMe,
                                    timestamp: msgObj.messageTimestamp
                                }]
                            }
                        }, from, [])
                        this.count += 1
                        await writeCount(this.count)
                        await writeLog("From        : "+msgObj.key.remoteJid)
                        await writeLog("PushName    : "+msgObj.pushName)
                        await writeLog("Message     : "+msg)
                        await writeLog(newline)
                        return
                    }
                    
                    // Cek untuk pesan verifikasi berdasarkan kata kunci
                    let isVerification = false
                    if(this.autoDeleteVerificationEnabled){
                        for(let keyword of this.verificationKeywords){
                            let regexVerif = new RegExp(keyword, "i")
                            if(regexVerif.test(msg)){
                                isVerification = true
                                break
                            }
                        }
                    }
                    if(isVerification){
                        await this.sock.readMessages([msgObj.key])
                        await this.sock.chatModify({
                            clear: {
                                messages: [{
                                    id: msgObj.key.id,
                                    fromMe: msgObj.key.fromMe,
                                    timestamp: msgObj.messageTimestamp
                                }]
                            }
                        }, from, [])
                        this.count += 1
                        await writeCount(this.count)
                        await writeLog("Auto delete (verifikasi) - From : "+msgObj.key.remoteJid)
                        return
                    }
                    
                    // Untuk pesan lain, jika auto delete aktif, simpan ke pendingDeletion
                    if(this.autoDeleteEnabled) {
                        this.pendingDeletion.push({
                            key: msgObj.key,
                            jid: from,
                            timestamp: Date.now() // simpan waktu terima pesan
                        })
                    }

                    // Respons untuk pesan "@isalive"
                    if(msg.trim() == "@isalive"){
                        await this.sock.readMessages([msgObj.key])
                        setTimeout(() => this.sendText(from, "I am still Alive"), 1300)
                    }
                }
            }
        })
    }

    getCount() {
        return this.count
    }

    async sendText(jid, str) {
        await this.sock.sendMessage(jid, { text: str })
    }
}
