# Harness Live · Pi from Scratch (ฉบับศึกษาเชิงลึก ไทย-อังกฤษ)

> **"What I cannot create, I do not understand."** — Richard Feynman  
> *(สิ่งใดที่ฉันสร้างขึ้นมาเองไม่ได้ แปลว่าฉันยังไม่เข้าใจมันอย่างแท้จริง)*

คู่มือและ Web Application แบบ Interactive สรุปและถอดรหัสเบื้องหลังการทำงานของ AI Coding Assistant (Coding Agent) จากบทเรียนต้นฉบับ [Harness Live · Pi from Scratch](https://harness.ohmmingrath.com/) โดย SaladDay และ Ohmmingrath

---

## 📌 สรุปโครงสร้างระบบ 5 โมดูล (The 5-Module Map)

1. **`src/llm.ts` (ล่ามแปลภาษา - The Translator)**: ทำหน้าที่แปลงข้อความ Context ภายใน ให้เป็นไปตามโปรโตคอลของ OpenAI `/chat/completions`, รับและแยกชิ้นส่วน SSE Stream (`text_delta`, `tool_call`, `done`, `error`)
2. **`src/agent.ts` (โฟร์แมนคุมงาน - The Foreman)**: คุม `while (true)` ลูป, สั่งรันเครื่องมือตามลำดับ, จดผลลัพธ์ลง Context, ดักจับข้อผิดพลาด `max_tokens` และดักยกเลิกอย่างขาวสะอาด (Abort)
3. **`src/tools.ts` (กล่องเครื่องมือ - The Toolbox)**: ฟังก์ชันที่มี Side Effects แตะต้องไฟล์และคอมพิวเตอร์จริง (`read_file`, `write_file`, `edit`, `run_bash`) พร้อมระบบ Truncate 200 บรรทัด
4. **`src/tui.ts` (โต๊ะต้อนรับ - Terminal UI)**: จัดการอินพุตผ่าน Node `readline`, พิมพ์ตัวอักษรแบบสตรีม, ดักการกด `Ctrl+C` เพื่อ Abort และคุม Busy State
5. **`src/cli.ts` (รางปลั๊กไฟรวมระบบ - Composition Root)**: จุดเชื่อมต่อทุกโมดูลเข้าด้วยกัน และบันทึกประวัติการคุยลงไฟล์ `~/.nanopi/session.jsonl`

---

## ⚖️ สรุป 5 ตัวอย่างเปรียบเทียบสำคัญ (Comparative Matrix)

1. **Chatbot ธรรมดา VS AI Coding Agent**: Single-turn Response ธรรมดา ไม่แตะโลกจริง VS Multi-turn Loop ที่อ่านผลลัพธ์การรันเทสต์แล้วสั่งแก้โค้ดซ้ำจนผ่าน
2. **Pure Functions VS Impure Tools (Side Effects)**: ฟังก์ชันคณิตศาสตร์ไร้ผลข้างเคียง VS เครื่องมือที่เขียนไฟล์จริงและสั่งรัน Shell ซึ่งไม่สามารถ Undo ได้หลังเกิด Side effect
3. **Normal HTTP Request VS SSE Streaming**: รอ 25 วินาทีหน้าจอนิ่ง VS สตรีมตัวอักษรแรกใน 400ms พร้อมระบบประกอบ Tool Call Arguments แบบไร้รอยต่อ
4. **Stateless Model VS Stateful Agent (Context Notebook)**: ตัว Model เองไม่มีความจำเลย (Stateless) แต่ Agent อาศัยสมุดโน้ต Context ที่คอยอัปเดตและบีบอัด (Compaction) เมื่อครบ 50 ข้อความ
5. **nano-pi VS Production Agent Frameworks**: ตัวอย่างฉบับเรียนรู้ ~900 บรรทัด VS ระบบจริงที่มี Sandboxing, Permission Prompting, Parallel Tool Execution และ AST Editing

---

## 🚀 วิธีเปิดใช้งานและ Deploy ขึ้น Vercel

### 1. เปิดดูบนเครื่อง Mac ตอนนี้เลย
```bash
open /Users/mrarranger/mrglab/index.html
```

### 2. Deploy ขึ้น Vercel
โปรเจกต์นี้รองรับ Vercel แบบ Zero-config (มี `vercel.json` และ `package.json` พร้อม):

**วิธีที่ 1: ใช้ Vercel CLI ใน Terminal**
```bash
cd /Users/mrarranger/mrglab
vercel --prod
```

**วิธีที่ 2: ใช้ GitHub Repo**
1. สร้าง Repo ใหม่บน GitHub (เช่น `mrarrangerteam/mrglab`)
2. Push โค้ดขึ้นไป:
   ```bash
   cd /Users/mrarranger/mrglab
   git remote add origin https://github.com/mrarrangerteam/mrglab.git
   git push -u origin main
   ```
3. เปิดหน้าแดชบอร์ด [https://vercel.com/mrarrangers-projects](https://vercel.com/mrarrangers-projects) แล้วกด **"Add New... -> Project"** เลือก `mrglab` เพื่อ Deploy ทันที!
