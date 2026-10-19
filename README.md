# DeepWorld

ลูกโลก 3 มิติที่แสดงความสูงของเปลือกโลก ทั้งบนบกและใต้มหาสมุทร เขียนด้วย Three.js และ custom shader

- **ทั้งโลก** (`/`) และ **เฉพาะประเทศไทย** (`/thai/`): หน้าประเทศไทยแสดงประเทศไทยแบบละเอียด (~300 ม./พิกเซล) ลอยอยู่กลางอวกาศ
- **2 ภาษา** ไทย/อังกฤษ: หน้าภาษาอังกฤษอยู่ที่ `/en/` และ `/en/thai/` สลับได้ด้วยปุ่ม English/ไทย
- **10 อันดับยอดเขาสูงที่สุดและจุดลึกที่สุดของโลก**: หมุดแสดงอันดับและจัดตำแหน่งไม่ให้ทับกัน การ์ดรายละเอียดมีภาพจาก Wikimedia Commons (ระบุผู้ถ่ายและสัญญาอนุญาต) และคำอธิบายจากวิกิพีเดีย
- ค้นหาจังหวัด อำเภอ ตำบล หรือพิกัด (กด `/` เพื่อเริ่มค้นหา) · ชี้เมาส์เพื่อดู ต./อ./จ. และความสูง
- เส้นแบ่งประเทศ (Natural Earth) และชื่อประเทศเมื่อชี้เมาส์ (ไทยจาก Wikidata / อังกฤษ)
- สเกลความสูงปรับช่วงตามพื้นที่ที่แสดงอยู่ มีชุดสี 3 แบบ (ธรรมชาติ, ความร้อน, ขาวดำ)
- คลิกจังหวัดเพื่อดูแบบ 3D ที่ความละเอียด ~38–75 ม./พิกเซล แผงตรวจสอบแสดงจุดสูงสุด/ต่ำสุดพร้อมชื่อสถานที่ histogram ความสูง และรายชื่ออำเภอ
- tile จะถูกเก็บใน Cache Storage และโหลดข้อมูลประเทศไทยกับจังหวัดที่ชี้อยู่ไว้ล่วงหน้าเบื้องหลัง
- ข้อมูล: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles), [OpenGISData-Thailand](https://github.com/chingchai/OpenGISData-Thailand) (CC BY 4.0), ชื่อยอดเขาจาก © OpenStreetMap contributors, เส้นแบ่งประเทศ [Natural Earth](https://www.naturalearthdata.com) (public domain)

## รัน

```bash
python3 serve.py 8173
```

แล้วเปิด http://localhost:8173 (ทั้งโลก) หรือ http://localhost:8173/thai (เฉพาะประเทศไทยแบบละเอียด)

## คำนวณจุดสูงสุด/ต่ำสุดรายจังหวัดใหม่

เปิด http://localhost:8173/tools/precompute.html แล้วกด "เริ่มคำนวณ" จากนั้นบันทึกผลเป็น `data/province-extremes.json`

## เอกสาร

ผลการวิจัย การวิเคราะห์ และการออกแบบอยู่ใน [docs/DESIGN.md](docs/DESIGN.md)

## SEO

- แต่ละหน้า/ภาษามี title, description, canonical, hreflang, Open Graph, Twitter card และ JSON-LD (WebApplication) ของตัวเอง สร้างจาก [`tools/build.py`](tools/build.py)
- favicon (SVG/ICO/PNG), apple-touch-icon, `manifest.webmanifest` และภาพสำหรับแชร์ `assets/og-image.jpg` (1200×630)
- `sitemap.xml` (มี hreflang) และ `robots.txt` สร้างตอน build
- `python3 tools/build.py _site` สร้างเว็บที่พร้อม deploy · `python3 tools/build.py --update-index` อัปเดต SEO block ใน `index.html`

## Deploy

ทุกครั้งที่ push ขึ้น `main` workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) จะ deploy ขึ้น GitHub Pages ให้อัตโนมัติ
- ทั้งโลก: https://giganto-th.github.io/deepworld/
- เฉพาะประเทศไทย: https://giganto-th.github.io/deepworld/thai/
- English: https://giganto-th.github.io/deepworld/en/

> หมายเหตุ: repo เป็น private และแพลนปัจจุบันของ org ยังไม่รองรับ GitHub Pages สำหรับ private repo จึงต้องเปลี่ยน repo เป็น public หรืออัปเกรดแพลนก่อน workflow จึงจะ deploy ได้
