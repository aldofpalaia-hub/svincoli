<?php
// /svincoli/update_rosters.php
declare(strict_types=1);

// === CONFIG ===
// Cambia il token e poi assicurati che il tuo UPLOAD_TOKEN su GitHub Actions coincida.
$expectedToken = 'CAMBIA-QUESTO-TOKEN-LUNGO-E-SEGRETO';

// Nome di default se non viene passato "final"
$defaultFinalName = 'negher rosters.xlsx';

// Cartella base consentita per gli upload (questa e le sue sottocartelle)
$baseDir = __DIR__;

// Limite dimensione file (10 MB)
$maxSize = 10 * 1024 * 1024;

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
$finfo   = new finfo(FILEINFO_MIME_TYPE);
$mime    = $finfo->file($_FILES['file']['tmp_name']) ?: '';
$allowed = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream', // alcuni hosting lo mettono generico
];
if (!in_array($mime, $allowed, true)) {
  http_response_code(415);
  exit('Tipo file non supportato: ' . $mime);
}

// === PARAMETRI OPZIONALI ===
// subdir: dove salvare dentro /svincoli (es. "svincoli" oppure "svincoli/classic")
$subdir = $_POST['subdir'] ?? ''; // es. "svincoli" o "svincoli/classic"
// final: nome file finale (es. "negher rosters.xlsx" o "Rose_-saudi-league-.xlsx")
$finalParam = $_POST['final'] ?? '';

// sanificazione subdir (solo caratteri ammessi + slash)
if ($subdir !== '') {
  if (strpos($subdir, '..') !== false) {
    http_response_code(400);
    exit('subdir non valida');
  }
  if (!preg_match('#^[a-zA-Z0-9 _\.\-\/]+$#', $subdir)) {
    http_response_code(400);
    exit('subdir contiene caratteri non ammessi');
  }
}

// sanificazione nome file finale
$finalName = $finalParam !== '' ? $finalParam : $defaultFinalName;
$finalName = preg_replace('/[^\w \.\-\(\)\[\]]/u', '_', $finalName);
if ($finalName === '' || $finalName === '.' || $finalName === '..') {
  http_response_code(400);
  exit('Nome file finale non valido');
}

// costruzione del percorso di destinazione
$targetDir = $baseDir;
if ($subdir !== '') {
  $targetDir = $baseDir . '/' . ltrim($subdir, '/');
}

// creazione cartella destinazione
if (!is_dir($targetDir) && !@mkdir($targetDir, 0775, true)) {
  http_response_code(500);
  exit('Impossibile creare la cartella di destinazione');
}

// realpath e check che sia sotto baseDir
$rpBase   = realpath($baseDir);
$rpTarget = realpath($targetDir);
if ($rpBase === false || $rpTarget === false || strpos($rpTarget, $rpBase) !== 0) {
  http_response_code(400);
  exit('Destinazione non consentita');
}

// cartella history dentro la target
$historyDir = $rpTarget . '/history';
if (!is_dir($historyDir)) { @mkdir($historyDir, 0775, true); }

// file di stato nella target
$statusFile = $rpTarget . '/status.json';

// === SAVE (atomic move) ===
$ts       = (new DateTime('now', new DateTimeZone('Europe/Rome')))->format('Y-m-d_H-i-s');
$tmpPath  = $rpTarget . '/upload_' . bin2hex(random_bytes(6)) . '.xlsx';
$final    = $rpTarget . '/' . $finalName;
$baseNoExt = pathinfo($finalName, PATHINFO_FILENAME);
$history  = $historyDir . '/' . "{$baseNoExt}_{$ts}.xlsx";

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
  'dir'          => trim(str_replace($rpBase, '', $rpTarget), '/') ?: '.',
  'filename'     => basename($final),
  'size_bytes'   => @filesize($final) ?: 0,
  'sha256'       => $hash,
  'history_file' => basename($history),
];
@file_put_contents($statusFile, json_encode($status, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

// opzionale: tieni solo gli ultimi 30 file di history
$files = glob($historyDir.'/*.xlsx');
rsort($files);
foreach (array_slice($files, 30) as $old) { @unlink($old); }

header('Content-Type: text/plain; charset=utf-8');
echo "OK upload & publish → {$status['dir']}/{$status['filename']}\n";
