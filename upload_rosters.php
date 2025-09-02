<?php
// /svincoli/upload_rosters.php
declare(strict_types=1);

// === CONFIG ===
$expectedToken = 'fantacalcio'; // cambia pure, poi aggiorna il secret UPLOAD_TOKEN
$finalName     = 'negher rosters.xlsx';
$maxSize       = 10 * 1024 * 1024; // 10 MB
$historyDir    = __DIR__ . '/history';
$statusFile    = __DIR__ . '/status.json';

// === AUTH ===
$hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
if (!preg_match('/^Bearer\s+(.+)$/i', $hdr, $m) || $m[1] !== $expectedToken) {
  http_response_code(403);
  exit('Forbidden');
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  http_response_code(405);
  header('Allow: POST');
  exit('Method Not Allowed');
}

// === INPUT ===
if (empty($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name'])) {
  http_response_code(400);
  exit('File mancante');
}
if ($_FILES['file']['error'] !== UPLOAD_ERR_OK) {
  http_response_code(400);
  exit('Errore upload: ' . $_FILES['file']['error']);
}
if ($_FILES['file']['size'] > $maxSize) {
  http_response_code(413);
  exit('File troppo grande');
}

// MIME check (accetta solo XLSX)
$finfo = new finfo(FILEINFO_MIME_TYPE);
$mime  = $finfo->file($_FILES['file']['tmp_name']) ?: '';
$allowed = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // alcuni hosting riportano generic 'application/octet-stream' sui .xlsx:
  'application/octet-stream'
];
if (!in_array($mime, $allowed, true)) {
  http_response_code(415);
  exit('Tipo file non supportato: ' . $mime);
}

// === SAVE (atomic move) ===
if (!is_dir($historyDir)) { @mkdir($historyDir, 0775, true); }

$ts       = (new DateTime('now', new DateTimeZone('Europe/Rome')))->format('Y-m-d_H-i-s');
$tmpPath  = __DIR__ . '/upload_' . bin2hex(random_bytes(6)) . '.xlsx';
$final    = __DIR__ . '/' . $finalName;
$history  = $historyDir . '/' . "negher_rosters_{$ts}.xlsx";

if (!move_uploaded_file($_FILES['file']['tmp_name'], $tmpPath)) {
  http_response_code(500);
  exit('Impossibile salvare (tmp)');
}

// copia nello storico e poi “rendi attivo” con rename atomico
@copy($tmpPath, $history);
@chmod($history, 0644);
@rename($tmpPath, $final);
@chmod($final, 0644);

// scrivi uno status.json per monitor/UX
$hash = @hash_file('sha256', $final) ?: '';
$status = [
  'updated_at'   => (new DateTime('now', new DateTimeZone('Europe/Rome')))->format(DateTime::ATOM),
  'size_bytes'   => @filesize($final) ?: 0,
  'sha256'       => $hash,
  'history_file' => basename($history),
];
@file_put_contents($statusFile, json_encode($status, JSON_PRETTY_PRINT));

// opzionale: tieni solo gli ultimi 30 file di history
$files = glob($historyDir.'/*.xlsx');
rsort($files);
foreach (array_slice($files, 30) as $old) { @unlink($old); }

header('Content-Type: text/plain; charset=utf-8');
echo "OK upload & publish → {$finalName}\n";
