<?php
declare(strict_types=1);

// ====== CONFIG ======
const UPLOAD_TOKEN = 'fantacalcio';
const DEST         = __DIR__ . '/negher rosters.xlsx';
const MAX_B        = 8*1024*1024; // 8 MB

// ====== AUTH ======
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (!hash_equals('Bearer '.UPLOAD_TOKEN, $auth)) {
  http_response_code(401); exit('NO_AUTH');
}

// ====== INPUT ======
if (empty($_FILES['file']['tmp_name'])) { http_response_code(400); exit('NOFILE'); }
if (filesize($_FILES['file']['tmp_name']) > MAX_B) { http_response_code(413); exit('TOO_BIG'); }

$ext = strtolower(pathinfo($_FILES['file']['name'] ?? '', PATHINFO_EXTENSION));
if ($ext !== 'xlsx') { http_response_code(415); exit('XLSX_ONLY'); }

// ====== SAVE ======
if (!move_uploaded_file($_FILES['file']['tmp_name'], DEST)) {
  http_response_code(500); exit('WRITE_ERR');
}
@chmod(DEST, 0644);
echo 'OK '.date('Y-m-d H:i:s');
