// ค่าเริ่มต้นของแอป (แก้ในหน้า "ตั้งค่า" บนมือถือได้ ไม่ต้องแก้ไฟล์นี้)
// ไฟล์นี้ใช้ทั้งในหน้าแอปและใน service worker
(function (g) {
  g.POS_CONFIG = {
    shopName: 'หมูพริ้ว',
    branchName: 'JLK Tower',   // ชื่อสาขาที่ออกใน CSV (ต้องตรงกับชื่อสาขาในชีท)
    branchId: 'jlk',           // รหัสสั้นของสาขาใน Supabase (ตรงกับ pos_branches.branch_id)
    deviceName: 'เครื่อง 1',
    supabaseUrl: '',           // เช่น https://xxxx.supabase.co
    apiKey: '',                // anon / publishable key (ไม่ใช่ service role)
    token: '',                 // รหัสลับของสาขา (ตั้งใน supabase.sql)
    menuIsDummy: true
  };

  // รายการเมนูตัวอย่าง (dummy) — "keypad" คือเลขที่กดบนเครื่อง ยังเป็นเลขสมมติ
  // รหัสระบบ (item_code) อ้างจากแท็บ Item Master ของ แฟชั่น B ไว้ก่อน
  g.POS_DEFAULT_MENU = [
    { keypad: '1',  code: 'FMFC033-034', name: 'ข้าวขาหมู',                 price: 60,  group: 'ข้าว' },
    { keypad: '2',  code: 'FMFC033-056', name: 'ข้าวหมูทอด',                price: 49,  group: 'ข้าว' },
    { keypad: '3',  code: 'FMFC033-037', name: 'ข้าวขาหมูรวมจัดเต็ม',       price: 90,  group: 'ข้าว' },
    { keypad: '4',  code: 'FMFC033-035', name: 'ข้าวคากิ',                  price: 60,  group: 'ข้าว' },
    { keypad: '5',  code: 'FMFC033-036', name: 'ข้าวไส้พะโล้',              price: 75,  group: 'ข้าว' },
    { keypad: '6',  code: 'FMFC033-038', name: 'ชุดขาหมูรวมจัดเต็ม',        price: 190, group: 'ชุด/เปล่า' },
    { keypad: '7',  code: 'FMFC033-039', name: 'ขาหมูเปล่า',                price: 160, group: 'ชุด/เปล่า' },
    { keypad: '8',  code: 'FMFC033-040', name: 'คากิเปล่า',                 price: 110, group: 'ชุด/เปล่า' },
    { keypad: '9',  code: 'FMFC033-041', name: 'ไส้พะโล้เปล่า',             price: 60,  group: 'ชุด/เปล่า' },
    { keypad: '10', code: 'FMFC033-046', name: 'ขาหมูยกขา',                 price: 290, group: 'ชุด/เปล่า' },
    { keypad: '11', code: 'FMFC033-042', name: 'ข้าวเปล่า',                 price: 15,  group: 'เพิ่ม' },
    { keypad: '12', code: 'FMFC033-044', name: 'เพิ่มไข่พะโล้',             price: 15,  group: 'เพิ่ม' },
    { keypad: '13', code: 'FMFC033-043', name: 'เพิ่มไส้พะโล้',             price: 25,  group: 'เพิ่ม' },
    { keypad: '14', code: 'FMFC033-045', name: 'เพิ่มผักดอง (กานาฉ่าย)',    price: 15,  group: 'เพิ่ม' }
  ];

  // ช่องทางชำระเงินบนเครื่อง (หน้า 1) — เลขที่กดหลังปุ่ม D
  g.POS_PAYMENTS = [
    { n: 1, name: 'Thai QR' },
    { n: 2, name: 'Dolfin' },
    { n: 3, name: 'Rabbit' },
    { n: 4, name: 'LINE Pay' },
    { n: 5, name: 'TRUE' },
    { n: 6, name: 'ShopeePay' },
    { n: 7, name: 'WeChat' },
    { n: 8, name: 'AliPay' }
  ];
})(typeof self !== 'undefined' ? self : window);
