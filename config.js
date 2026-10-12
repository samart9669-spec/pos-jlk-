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
    menuIsDummy: false
  };

  // รายการเมนูตัวอย่าง (dummy) — "keypad" คือเลขที่กดบนเครื่อง ยังเป็นเลขสมมติ
  // รหัสระบบ (item_code) อ้างจากแท็บ Item Master ของ แฟชั่น B ไว้ก่อน
  g.POS_DEFAULT_MENU = [
    { keypad: '1', code: 'JLK-001', name: 'ข้าวขาหมูมหาชน (อิ่มพอดี)', price: 50, group: 'ข้าวขาหมู' },
    { keypad: '2', code: 'JLK-002', name: 'ข้าวขาหมู', price: 70, group: 'ข้าวขาหมู' },
    { keypad: '3', code: 'JLK-003', name: 'ข้าวกะเพราขาหมู', price: 70, group: 'ข้าวขาหมู' },
    { keypad: '4', code: 'JLK-004', name: 'ข้าวขาหมูลืน', price: 80, group: 'ข้าวขาหมู' },
    { keypad: '5', code: 'JLK-005', name: 'ข้าวขาหมูรวมพล (เนื้อ คากิ ไส้ ไข่)', price: 90, group: 'ข้าวขาหมู' },
    { keypad: '6', code: 'JLK-006', name: 'ขาหมูรวมพล (เนื้อ คากิ ไส้ ไข่)', price: 160, group: 'ขาหมูเปล่า' },
    { keypad: '7', code: 'JLK-007', name: 'ข้าวหมูทอด', price: 65, group: 'ข้าวหมู' },
    { keypad: '8', code: 'JLK-008', name: 'ข้าวหมู2สหาย', price: 80, group: 'ข้าวหมู' },
    { keypad: '9', code: 'JLK-009', name: 'ข้าวหมูทอดพริกเกลือ', price: 65, group: 'ข้าวหมู' },
    { keypad: '10', code: 'JLK-010', name: 'เพิ่ม ข้าวเปล่า', price: 10, group: 'เพิ่ม' },
    { keypad: '11', code: 'JLK-011', name: 'เพิ่ม ไส้พะโล้', price: 15, group: 'เพิ่ม' },
    { keypad: '12', code: 'JLK-012', name: 'เพิ่ม ไข่พะโล้', price: 10, group: 'เพิ่ม' },
    { keypad: '13', code: 'JLK-013', name: 'เพิ่ม พิเศษ', price: 10, group: 'เพิ่ม' },
    { keypad: '14', code: 'JLK-014', name: 'เพิ่มหมูทอด', price: 15, group: 'เพิ่ม' },
    { keypad: '15', code: 'JLK-015', name: 'เพิ่มกานาฉ่าย', price: 10, group: 'เพิ่ม' },
    { keypad: '16', code: 'JLK-016', name: 'น้ำเปล่า', price: 10, group: 'อื่นๆ' },
    { keypad: '17', code: 'JLK-017', name: 'ใส่กล่อง', price: 5, group: 'อื่นๆ' }
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
