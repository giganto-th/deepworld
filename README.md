# DeepWorld

ลูกโลก 3 มิติที่แสดงความสูงของเปลือกโลก ทั้งบนบกและใต้มหาสมุทร เขียนด้วย Three.js และ custom shader

- **ทั้งโลก** (`/`) และ **เฉพาะประเทศไทย** (`/thai/`): หน้าประเทศไทยแสดงประเทศไทยแบบละเอียด (~300 ม./พิกเซล) ลอยอยู่กลางอวกาศ
- ค้นหาจังหวัด อำเภอ ตำบล หรือพิกัด (กด `/` เพื่อเริ่มค้นหา) · ชี้เมาส์เพื่อดู ต./อ./จ. และความสูง
- สเกลความสูงปรับช่วงตามพื้นที่ที่แสดงอยู่ มีชุดสี 3 แบบ (ธรรมชาติ, ความร้อน, ขาวดำ)
- คลิกจังหวัดเพื่อดูแบบ 3D ที่ความละเอียด ~38–75 ม./พิกเซล แผงตรวจสอบแสดงจุดสูงสุด/ต่ำสุดพร้อมชื่อสถานที่ histogram ความสูง และรายชื่ออำเภอ
- tile จะถูกเก็บใน Cache Storage และโหลดข้อมูลประเทศไทยกับจังหวัดที่ชี้อยู่ไว้ล่วงหน้าเบื้องหลัง
- ข้อมูล: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles), [OpenGISData-Thailand](https://github.com/chingchai/OpenGISData-Thailand) (CC BY 4.0), ชื่อยอดเขาจาก © OpenStreetMap contributors

## รัน

```bash
python3 serve.py 8173
```

แล้วเปิด http://localhost:8173 (ทั้งโลก) หรือ http://localhost:8173/thai (เฉพาะประเทศไทยแบบละเอียด)

## คำนวณจุดสูงสุด/ต่ำสุดรายจังหวัดใหม่

เปิด http://localhost:8173/tools/precompute.html แล้วกด "เริ่มคำนวณ" จากนั้นบันทึกผลเป็น `data/province-extremes.json`

## เอกสาร

ผลการวิจัย การวิเคราะห์ และการออกแบบอยู่ใน [docs/DESIGN.md](docs/DESIGN.md)

## Deploy

ทุกครั้งที่ push ขึ้น `main` workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) จะ deploy ขึ้น GitHub Pages ให้อัตโนมัติ
- ทั้งโลก: https://giganto-th.github.io/deepworld/
- เฉพาะประเทศไทย: https://giganto-th.github.io/deepworld/thai/
