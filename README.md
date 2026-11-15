# Claude Auto Shutdown

ปิด Windows อัตโนมัติเมื่อ Claude Code (ใน Claude desktop app หรือ CLI) ทำงานเสร็จ

## ใช้งาน

1. เปิด `release\Claude Auto Shutdown-win32-x64\Claude Auto Shutdown.exe`
2. กด **เริ่มเฝ้า** ก่อนนอน แล้วปล่อยแอปไว้ (ปิดหน้าต่างได้ แอปจะไปอยู่ใน tray)
3. เมื่อ Claude ว่างต่อเนื่อง 10 นาที แอปจะนับถอยหลัง 20 นาที ตรวจซ้ำอีกรอบ แล้วสั่ง `shutdown /s /f /t 0`

ระหว่างนับถอยหลัง ถ้า Claude กลับมาทำงานหรือมีคนขยับเมาส์ แอปจะยกเลิกเอง ตั้งค่าทุกอย่างได้ในหัวข้อ "ตั้งค่า"

## ตรวจจับอย่างไร

- `%USERPROFILE%\.claude\sessions\<pid>.json` ของแต่ละ session มีสถานะ `busy` / `idle` โดยแอปเช็คด้วยว่า process ยังอยู่จริง
- shell ที่ Claude สั่งไว้ (รวม background task) ยังรันอยู่หรือไม่ ดูจาก process ลูกของ session
- session ที่ busy แต่เงียบเกิน 45 นาที (เช่น ติดหน้าขออนุญาต) นับว่าเสร็จ
- ถ้าตรวจไม่ได้ จะไม่ปิดเครื่อง

## Log

เก็บใน SQLite ที่ `%APPDATA%\Claude Auto Shutdown\logs.sqlite` (ตาราง `events`: `id, at, level, message`) เก็บไว้ 30 วัน ข้อมูลที่เก่ากว่านั้นจะถูกลบตอนเปิดแอปและทุกชั่วโมง

## พัฒนา

```bash
npm install
node node_modules/electron/install.js   # Electron 45 ไม่ดาวน์โหลด binary ตอน npm install
npm start            # รันแอป
npm run start:dry    # รันแบบโหมดทดสอบ (ไม่ปิดเครื่องจริง)
npm test             # unit test
npm run e2e          # ทดสอบแอปจริงครบรอบแบบ dry-run
npm run detect       # ดูว่าตัวตรวจเห็นอะไรตอนนี้ (--full = ตรวจ process ด้วย)
npm run package      # สร้างโฟลเดอร์ .exe ใน release/
```

Flag ของแอป: `--dry-run` (บังคับโหมดทดสอบ), `--hidden` (เริ่มแบบซ่อนใน tray)
