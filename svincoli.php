<?php
declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;
use PhpOffice\PhpSpreadsheet\Cell\Coordinate;
use GuzzleHttp\Client;

/* ========================== CONFIG ========================== */

const ROSTERS_XLSX = __DIR__ . '/negher rosters.xlsx'; // <— cambia se vuoi
const PAGE_URL     = 'https://www.fantacalcio.it/quotazioni-fantacalcio'; // Mantra + Stagione 2025/26
const PRICES_URL   = 'https://www.fantacalcio.it/api/v1/Excel/prices/20/1'; // spesso 401
const CACHE_DIR    = __DIR__ . '/cache';
const CACHE_XLSX   = CACHE_DIR . '/prices.xlsx';  // cache da upload Excel
const CACHE_JSON   = CACHE_DIR . '/prices.json';  // cache da scraping / incolla
const MAX_UPLOAD_B = 8 * 1024 * 1024; // 8 MB

/* ========================== UTILS =========================== */

function norm(string $s): string {
    $s = trim($s);
    $s = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s) ?: $s;
    $s = strtolower($s);
    $s = preg_replace('/[^a-z0-9\s]/u', ' ', $s);
    $s = preg_replace('/\s+/', ' ', $s);
    return trim($s);
}
function half_up(float $v): int { return (int) round($v, 0, PHP_ROUND_HALF_UP); }
function ensureCacheDir(): void { if (!is_dir(CACHE_DIR)) mkdir(CACHE_DIR, 0775, true); }
function humanDT($ts): string { return (is_int($ts) && $ts > 0) ? date('d/m/Y H:i', $ts) : 'n/d'; }
function numify($v): float {
    $s = trim((string)$v);
    if ($s==='') return 0.0;
    $s = preg_replace('/[.\s]/', '', $s); // separatori migliaia
    $s = str_replace(',', '.', $s);       // virgola -> punto
    return (float)$s;
}
function cellVal(Worksheet $sh, int $col, int $row) {
    $addr = Coordinate::stringFromColumnIndex($col) . $row;
    return $sh->getCell($addr)->getValue();
}
function cellCalc(Worksheet $sh, int $col, int $row) {
    $addr = Coordinate::stringFromColumnIndex($col) . $row;
    return $sh->getCell($addr)->getCalculatedValue();
}
function getLogoDataUrl(): ?string {
    foreach (['logo.jpg','logo.jpeg','logo.png'] as $f) {
        $p = __DIR__ . '/' . $f;
        if (is_file($p)) {
            $mime = str_ends_with($f, '.png') ? 'image/png' : 'image/jpeg';
            return "data:$mime;base64," . base64_encode((string)file_get_contents($p));
        }
    }
    return null;
}
function findHeader(array $headers, array $cands): int {
    foreach ($cands as $c) { $i = array_search(strtolower($c), $headers, true); if ($i !== false) return (int)$i; }
    return -1;
}

/* =================== AZIONI (UPLOAD/PASTE/FETCH) ============= */

$flash = null; $flashType = 'info';

// Upload Excel prezzi
if (($_POST['action'] ?? '') === 'upload_prices' && isset($_FILES['prices_xlsx'])) {
    try {
        if (!is_uploaded_file($_FILES['prices_xlsx']['tmp_name'])) throw new RuntimeException('Upload non valido.');
        if ((int)$_FILES['prices_xlsx']['size'] > MAX_UPLOAD_B) throw new RuntimeException('File troppo grande (max 8MB).');
        $ext = strtolower(pathinfo($_FILES['prices_xlsx']['name'], PATHINFO_EXTENSION));
        if ($ext !== 'xlsx') throw new RuntimeException('Carica un file Excel .xlsx');
        ensureCacheDir();
        @unlink(CACHE_JSON);
        if (!move_uploaded_file($_FILES['prices_xlsx']['tmp_name'], CACHE_XLSX)) throw new RuntimeException('Impossibile salvare il file.');
        $flash = 'Listino Excel caricato.'; $flashType = 'ok';
    } catch (Throwable $e) { $flash = 'Errore upload: '.$e->getMessage(); $flashType = 'err'; }
}

// Incolla CSV/TSV dalla pagina
if (($_POST['action'] ?? '') === 'paste_prices') {
    try {
        $txt = (string)($_POST['prices_paste'] ?? '');
        $map = parsePastedPricesToMap($txt);
        if (!$map) throw new RuntimeException('Formato non riconosciuto. Servono intestazioni: Calciatore, Squadra, QI, QA (opz. Ruolo).');
        ensureCacheDir(); file_put_contents(CACHE_JSON, json_encode($map, JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT));
        @unlink(CACHE_XLSX);
        $flash = 'Listino salvato dai dati incollati.'; $flashType = 'ok';
    } catch (Throwable $e) { $flash = 'Errore incolla: '.$e->getMessage(); $flashType = 'err'; }
}

// Scraping dalla pagina (Mantra 25/26)
if (($_GET['action'] ?? '') === 'fetch_web') {
    try {
        $map = scrapePricesFromPage(PAGE_URL);
        if (!$map) throw new RuntimeException('Nessun dato estratto.');
        ensureCacheDir(); file_put_contents(CACHE_JSON, json_encode($map, JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT));
        @unlink(CACHE_XLSX);
        $flash = 'Listino aggiornato dalla pagina (Mantra 25/26).'; $flashType = 'ok';
    } catch (Throwable $e) { $flash = 'Errore fetch web: '.$e->getMessage(); $flashType = 'err'; }
}

/* ====================== ROSTERS READER ======================= */

function loadRosters(string $xlsxPath): array {
    if (!file_exists($xlsxPath)) throw new RuntimeException("File roster non trovato: " . basename($xlsxPath));
    $spreadsheet = IOFactory::load($xlsxPath);
    $sheet = $spreadsheet->getSheetByName('TutteLeRose') ?? $spreadsheet->getSheet(0);

    // 1) Parser layout "TutteLeRose" (blocchi 4 colonne)
    $teams = parseNegherGrid($sheet);
    if (!empty($teams)) return $teams;

    // 2) Fallback: vecchio layout “coppie di colonne” (Team | Costo)
    $teams = parseColumnPairs($sheet);
    if (!empty($teams)) return $teams;

    throw new RuntimeException('Formato roster non riconosciuto. Attesi blocchi "Ruolo/Calciatore/Squadra/Costo" o colonne (Team|Costo).');
}

/** Blocchi da 4 colonne: [Ruolo | Calciatore | Squadra | Costo] */
function parseNegherGrid(Worksheet $sheet): array {
    $highestRow = $sheet->getHighestRow();
    $highestCol = Coordinate::columnIndexFromString($sheet->getHighestColumn());
    if ($highestCol < 4) return [];

    $teams = [];

    for ($r = 1; $r <= $highestRow - 1; $r++) {
        for ($c = 1; $c <= $highestCol - 3; $c++) {
            $h1 = strtolower(trim((string) cellVal($sheet, $c,     $r+1)));
            $h2 = strtolower(trim((string) cellVal($sheet, $c + 1, $r+1)));
            $h3 = strtolower(trim((string) cellVal($sheet, $c + 2, $r+1)));
            $h4 = strtolower(trim((string) cellVal($sheet, $c + 3, $r+1)));

            if ($h1 === 'ruolo' && $h2 === 'calciatore' && $h3 === 'squadra' && str_contains($h4, 'costo')) {
                $teamName = trim((string) cellVal($sheet, $c, $r));
                if ($teamName === '' || preg_match('/^crediti residui/i', $teamName) || preg_match('/^https?:\/\//i', $teamName)) {
                    continue;
                }
                $row = $r + 2;
                while ($row <= $highestRow) {
                    $ruolo = trim((string) cellVal($sheet, $c,     $row));
                    $nome  = trim((string) cellVal($sheet, $c + 1, $row));
                    $squad = trim((string) cellVal($sheet, $c + 2, $row));
                    $costo = cellCalc($sheet, $c + 3, $row);

                    $left = strtolower($ruolo);
                    if (($ruolo === '' && $nome === '' && $squad === '') || str_starts_with($left, 'crediti residui')) break;

                    if ($nome !== '') {
                        $teams[$teamName][] = ['player'=>$nome, 'costo'=>(float)$costo, 'ruolo'=>$ruolo];
                    }
                    $row++;
                }
                $c += 3; // salta blocco
            }
        }
    }
    return $teams;
}

/** Fallback storico: colonne a coppie [Nome squadra | Costo] (nessun ruolo disponibile) */
function parseColumnPairs(Worksheet $sheet): array {
    $highestRow = $sheet->getHighestRow();
    $highestCol = Coordinate::columnIndexFromString($sheet->getHighestColumn());
    $teams = [];
    for ($col = 1; $col <= $highestCol; $col++) {
        $header     = (string) cellVal($sheet, $col, 1);
        $nextHeader = $col + 1 <= $highestCol ? (string) cellVal($sheet, $col + 1, 1) : '';
        if ($header !== '' && preg_match('/costo/i', $nextHeader)) {
            $teamName = trim($header);
            for ($row = 2; $row <= $highestRow; $row++) {
                $player = (string) cellVal($sheet, $col, $row);
                if ($player === '' || strtoupper($player) === 'N/A') continue;
                $costo  = cellCalc($sheet, $col + 1, $row);
                if ($costo === null || $costo === '') continue;
                $teams[$teamName][] = ['player'=>trim($player), 'costo'=>(float)$costo, 'ruolo'=>''];
            }
            $col++; // salta "Costo"
        }
    }
    return $teams;
}

/* ======================= PREZZI (3 fonti) ===================== */

function loadPriceList(): array {
    // 1) JSON da scraping/incolla
    if (file_exists(CACHE_JSON)) {
        $arr = json_decode((string)file_get_contents(CACHE_JSON), true);
        if (is_array($arr)) return $arr;
    }
    // 2) Excel da upload
    if (file_exists(CACHE_XLSX)) {
        return loadPriceListXlsx(CACHE_XLSX);
    }
    // 3) Tentativo Excel remoto (spesso 401)
    try {
        $client = new Client(['timeout'=>25,'headers'=>['User-Agent'=>'NegherLeague Svincoli/1.6']]);
        $res = $client->get(PRICES_URL);
        if ($res->getStatusCode()===200){
            ensureCacheDir();
            file_put_contents(CACHE_XLSX, $res->getBody()->getContents());
            return loadPriceListXlsx(CACHE_XLSX);
        }
    } catch (\Throwable $e) { /* ignoriamo */ }
    throw new RuntimeException('Nessun listino disponibile. Usa “Aggiorna da pagina”, “Carica Excel” o “Incolla dati”.');
}

function loadPriceListXlsx(string $file): array {
    $ss = IOFactory::load($file);
    $sh = $ss->getSheet(0);

    $headers = [];
    $maxC = Coordinate::columnIndexFromString($sh->getHighestColumn());
    for ($c=1; $c<=$maxC; $c++) {
        $h = strtolower(trim((string)cellVal($sh, $c, 1)));
        if ($h!=='') $headers[$h] = $c;
    }
    $colNome = $headers['nome'] ?? $headers['calciatore'] ?? 1;
    $colRuolo= $headers['ruolo'] ?? 2;
    $colSq   = $headers['squadra'] ?? $headers['team'] ?? 3;
    $colQA   = $headers['quotazione'] ?? $headers['q attuale'] ?? 4;
    $colQI   = $headers['quotazione iniziale'] ?? $headers['q iniziale'] ?? 5;

    $map = [];
    $maxR = $sh->getHighestRow();
    for ($r=2; $r<=$maxR; $r++) {
        $nome = trim((string)cellVal($sh, $colNome, $r));
        if ($nome==='') continue;
        $ruolo = (string)cellVal($sh, $colRuolo, $r);
        $sq    = (string)cellVal($sh, $colSq,    $r);
        $qa    = numify(cellCalc($sh, $colQA,    $r));
        $qi    = numify(cellCalc($sh, $colQI,    $r));
        if ($qi<=0) continue;
        $map[norm($nome)] = ['nome'=>$nome,'ruolo'=>$ruolo,'squadra'=>$sq,'q_att'=>$qa,'q_ini'=>$qi];
    }
    return $map;
}

/* ===================== SCRAPING (Mantra + Ruoli) =============== */

function extractRoleToken(string $s): string {
    $rx = '/(?<![A-Za-zÀ-ÖØ-öø-ÿ])(Por|Dc|Dd|Ds|E|M|C|W|T|A|Pc)(?![A-Za-zÀ-ÖØ-öø-ÿ])/u';
    return preg_match($rx, $s, $m) ? $m[1] : '';
}

function scrapePricesFromPage(string $url): array {
    $client = new Client([
        'timeout' => 25,
        'headers' => [
            'User-Agent'      => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
            'Accept'          => 'text/html,application/xhtml+xml',
            'Accept-Language' => 'it-IT,it;q=0.9,en;q=0.8',
        ],
    ]);
    $res = $client->get($url);
    if ($res->getStatusCode() !== 200) throw new RuntimeException('HTTP '.$res->getStatusCode());

    $html = (string)$res->getBody();
    $html = preg_replace('#<script[^>]*>.*?</script>#is', '', $html);
    $html = preg_replace('#<style[^>]*>.*?</style>#is', '', $html);

    $txt  = html_entity_decode(strip_tags($html), ENT_QUOTES|ENT_HTML5, 'UTF-8');
    $txt  = str_replace(["\xC2\xA0", "\xE2\x80\xAF", "\xEF\xBB\xBF"], ' ', $txt); // NBSP ecc.
    $txt  = preg_replace('/[ \t]+/u', ' ', $txt);
    $txt  = preg_replace('/\R+/u', "\n", $txt);

    $pattern = '/(^|[\n\r])\s*' .
               '([A-Za-zÀ-ÖØ-öø-ÿ0-9\.\'\- ]{2,})\s+' . // nome (2)
               '([A-Z]{2,3})\s+' .                      // squadra (3)
               '(\d{1,3})\s+(\d{1,3})\s+[\d,.]{1,5}\s+' .
               '(\d{1,3})\s+(\d{1,3})\s+[\d,.]{1,5}\s*(?=\n|$)/u';

    if (!preg_match_all($pattern, $txt, $rows, PREG_SET_ORDER)) {
        throw new RuntimeException('Parser: nessuna riga trovata. Assicurati Mantra + 2025/26.');
    }

    $map = [];
    foreach ($rows as $r) {
        $full  = $r[0];
        $nome  = trim($r[2]);
        $squad = trim($r[3]);
        $qi2   = (float)$r[6];
        $qa2   = (float)$r[7];
        if ($qi2 <= 0) continue;

        $pos   = mb_stripos($full, $nome);
        $before= $pos !== false ? mb_substr($full, 0, $pos) : $full;
        $ruolo = extractRoleToken($before);

        $map[norm($nome)] = [
            'nome'    => $nome,
            'ruolo'   => $ruolo,
            'squadra' => $squad,
            'q_att'   => $qa2,
            'q_ini'   => $qi2,
        ];
    }
    if (!$map) throw new RuntimeException('Parser: nessun dato utile estratto.');
    return $map;
}

/* ===================== PASTE PARSER (CSV/TSV) ================== */

function parsePastedPricesToMap(string $txt): array {
    $txt = trim($txt);
    if ($txt==='') return [];
    $first = strtok($txt, "\r\n");
    $sep = (strpos($first, "\t") !== false) ? "\t" : ((strpos($first,';')!==false)?';':',');

    $lines = preg_split('/\r\n|\r|\n/', $txt);
    if (!$lines || count($lines) < 2) return [];

    $headers = array_map(fn($h) => strtolower(trim($h)), str_getcsv(array_shift($lines), $sep));
    $idx = [
        'ruolo'  => findHeader($headers, ['ruolo']),
        'nome'   => findHeader($headers, ['calciatore','nome','giocatore']),
        'squadra'=> findHeader($headers, ['squadra','sq']),
        'qi'     => findHeader($headers, ['qi','q iniziale','quotazione iniziale']),
        'qa'     => findHeader($headers, ['qa','q attuale','quotazione']),
    ];
    if ($idx['nome']===-1 || $idx['qi']===-1 || $idx['qa']===-1) return [];

    $map = [];
    foreach ($lines as $line) {
        if (!trim($line)) continue;
        $cols = str_getcsv($line, $sep);
        $nome  = trim((string)($cols[$idx['nome']] ?? '')); if ($nome==='') continue;
        $ruolo = $idx['ruolo']   !== -1 ? trim((string)($cols[$idx['ruolo']]   ?? '')) : '';
        $squad = $idx['squadra'] !== -1 ? trim((string)($cols[$idx['squadra']] ?? '')) : '';
        $qi    = $idx['qi']      !== -1 ? numify($cols[$idx['qi']]) : 0.0;
        $qa    = $idx['qa']      !== -1 ? numify($cols[$idx['qa']]) : 0.0;
        if ($qi <= 0) continue;
        $map[norm($nome)] = ['nome'=>$nome,'ruolo'=>$ruolo,'squadra'=>$squad,'q_att'=>$qa,'q_ini'=>$qi];
    }
    return $map;
}

/* =================== CALCOLO RIMBORSO SQUADRA ================= */

function computeTeamPayouts(array $teamPlayers, array $priceMap): array {
    $rows = [];
    foreach ($teamPlayers as $row) {
        $playerName = $row['player'];
        $purchase   = (float)$row['costo'];
        $ruoloRoster= (string)($row['ruolo'] ?? '');
        $key = norm($playerName);
        $found = $priceMap[$key] ?? null;

        if ($found) {
            $qAtt = (float)$found['q_att'];
            $qIni = (float)$found['q_ini'];
            $raw  = $qIni > 0 ? ($purchase * $qAtt) / $qIni : 0.0;
            $rows[] = [
                'player'=>$found['nome'],
                'ruolo'=>$ruoloRoster !== '' ? $ruoloRoster : (string)$found['ruolo'],
                'squadra'=>$found['squadra'],
                'acquisto'=>$purchase,'q_att'=>$qAtt,'q_ini'=>$qIni,
                'calc'=>$raw,'rimborso'=>half_up($raw),'match'=>'OK'
            ];
        } else {
            $rows[] = [
                'player'=>$playerName,'ruolo'=>$ruoloRoster,'squadra'=>'',
                'acquisto'=>$purchase,'q_att'=>null,'q_ini'=>null,'calc'=>null,'rimborso'=>null,'match'=>'NON TROVATO'
            ];
        }
    }
    return $rows;
}

/* =========================== CONTROLLER ======================= */

$error = null; $teams=[]; $prices=[];
$selectedTeam = $_GET['team'] ?? '';

try { $teams = loadRosters(ROSTERS_XLSX); } catch (Throwable $e) { $error = $e->getMessage(); }
try { if (!$error) $prices = loadPriceList(); } catch (Throwable $e) { $error = $e->getMessage(); }

$teamNames = array_keys($teams);
if ($selectedTeam && !in_array($selectedTeam, $teamNames, true)) $selectedTeam = '';
$results = ($selectedTeam && isset($teams[$selectedTeam])) ? computeTeamPayouts($teams[$selectedTeam], $prices) : [];
$logoUrl = getLogoDataUrl();

/* ============================ VIEW =========================== */
?>
<!doctype html>
<html lang="it" data-bs-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NegherLeague • Svincoli</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<style>
:root{ --brand-primary:#f39c12; --brand-dark:#0b0d10; }
body{background:var(--brand-dark); color:#e8eef2}
.navbar{background:#10151b;border-bottom:1px solid #1f2630}
.navbar-brand{display:flex;align-items:center;gap:.6rem;font-weight:700}
.navbar-brand img{height:40px;width:auto;border-radius:8px}
.card{background:#12161b;border:1px solid #1f2630;border-radius:14px}
.badge-outline{border:1px solid #2a3340;background:#0f1318;color:#aeb8c5}
.table>:not(caption)>*>*{border-bottom-color:#243041}
.btn-primary{--bs-btn-bg:var(--brand-primary);--bs-btn-border-color:var(--brand-primary);--bs-btn-hover-bg:#d8870c;--bs-btn-hover-border-color:#d8870c}
.sticky-summary{position:sticky; bottom:0; background:#0f1318; border-top:1px solid #1f2630; padding:.75rem 1rem;}
</style>
</head>
<body>
<nav class="navbar mb-4">
  <div class="container">
    <a class="navbar-brand" href="#">
      <?php if ($logoUrl): ?><img src="<?= htmlspecialchars($logoUrl) ?>" alt="NegherLeague logo"><?php endif; ?>
      <span>NegherLeague • Svincoli</span>
    </a>
  </div>
</nav>

<div class="container">

  <?php if ($error): ?>
    <div class="alert alert-danger">
      <strong>Errore:</strong> <?= htmlspecialchars($error) ?><br>
      Usa <em>Aggiorna da pagina</em>, <em>Carica Excel</em> oppure <em>Incolla dati</em>.
    </div>
  <?php endif; ?>

  <?php if (!empty($flash)): ?>
    <div class="alert <?= $flashType==='ok'?'alert-success':($flashType==='err'?'alert-danger':'alert-warning') ?>">
      <?= htmlspecialchars($flash) ?>
    </div>
  <?php endif; ?>

  <div class="card mb-4">
    <div class="card-body">
      <form class="row gy-3 gx-3 align-items-end" method="get" action="">
        <div class="col-12 col-md-6">
          <label for="team" class="form-label">Seleziona squadra</label>
          <select id="team" name="team" class="form-select" onchange="this.form.submit()">
            <option value="">— scegli —</option>
            <?php foreach ($teamNames as $t): ?>
              <option value="<?= htmlspecialchars($t) ?>" <?= $t===$selectedTeam?'selected':'' ?>><?= htmlspecialchars(mb_strtoupper($t,'UTF-8')) ?></option>
            <?php endforeach; ?>
          </select>
        </div>
        <div class="col-12 col-md-auto">
          <button type="submit" class="btn btn-primary">Calcola</button>
        </div>
        <div class="col-12 col-md-auto">
          <a class="btn btn-outline-light" href="?action=fetch_web<?= $selectedTeam ? '&team='.urlencode($selectedTeam) : '' ?>">Aggiorna da pagina (Mantra 25/26)</a>
        </div>
        <div class="col-12">
          <span class="badge badge-outline">Cache Excel: <?= htmlspecialchars(humanDT(@filemtime(CACHE_XLSX))) ?></span>
          <span class="badge badge-outline ms-2">Cache Web/Incolla: <?= htmlspecialchars(humanDT(@filemtime(CACHE_JSON))) ?></span>
          <span class="badge badge-outline ms-2">Formula: (Acquisto × QA) / QI → HALF UP</span>
        </div>
      </form>
    </div>
  </div>

  <?php if ($selectedTeam): ?>
    <div class="card mb-5">
      <div class="card-header d-flex justify-content-between align-items-center">
        <h5 class="mb-0"><?= htmlspecialchars(mb_strtoupper($selectedTeam,'UTF-8')) ?></h5>
        <span class="text-secondary small">Sorgente prezzi: <?= file_exists(CACHE_JSON) ? 'Web/Incolla' : (file_exists(CACHE_XLSX) ? 'Excel' : 'Remoto') ?></span>
      </div>
      <div class="card-body p-0">
        <div class="table-responsive">
          <table id="tbl" class="table table-dark table-striped table-hover align-middle mb-0">
            <thead>
            <tr>
              <th style="width:44px">
                <input class="form-check-input" type="checkbox" id="checkAll" title="Seleziona tutti">
              </th>
              <th style="min-width:180px">Calciatore</th>
              <th style="min-width:70px">Ruolo</th>
              <th>Squadra</th>
              <th>Acquisto</th>
              <th>Q. attuale</th>
              <th>Q. iniziale</th>
              <th>Calcolo grezzo</th>
              <th>Rimborso</th>
              <th>Match</th>
            </tr>
            </thead>
            <tbody>
<?php $tot = 0; foreach ($results as $i => $r): $tot += (int)($r['rimborso'] ?? 0); ?>
  <?php
    $canSelect    = $r['rimborso'] !== null;
    $rim          = $r['rimborso'] !== null ? (int)$r['rimborso'] : 0;

    // Colore rimborso in base al confronto con l'acquisto
    $rimborsoVal  = $r['rimborso'];
    $acquistoVal  = (float)$r['acquisto'];
    if ($rimborsoVal !== null) {
        if ($rimborsoVal < $acquistoVal)      { $rimClass = 'text-danger'; } // rosso
        elseif ($rimborsoVal > $acquistoVal)  { $rimClass = 'text-success'; } // verde
        else                                   { $rimClass = 'text-white'; }  // bianco
    } else {
        $rimClass = 'text-muted'; // per il trattino '-'
    }
  ?>
  <tr class="<?= $r['match']==='OK' ? '' : 'table-warning' ?>">
    <td>
      <input class="row-check form-check-input" type="checkbox"
             <?= $canSelect ? '' : 'disabled' ?>
             data-rimborso="<?= htmlspecialchars((string)$rim) ?>">
    </td>
    <td><?= htmlspecialchars($r['player']) ?></td>
    <td>
      <?php if (!empty($r['ruolo'])): ?>
        <span class="badge text-dark" style="background:var(--brand-primary)"><?= htmlspecialchars($r['ruolo']) ?></span>
      <?php else: ?><span class="text-muted">—</span><?php endif; ?>
    </td>
    <td><?= htmlspecialchars($r['squadra'] ?: '-') ?></td>
    <td><?= number_format((float)$r['acquisto'], 0, ',', '.') ?></td>
    <td><?= $r['q_att']!==null ? number_format((float)$r['q_att'], 0, ',', '.') : '-' ?></td>
    <td><?= $r['q_ini']!==null ? number_format((float)$r['q_ini'], 0, ',', '.') : '-' ?></td>
    <td><?= $r['calc']!==null ? number_format((float)$r['calc'], 2, ',', '.') : '-' ?></td>

    <!-- Rimborso colorato -->
    <td>
      <strong class="<?= $rimClass ?>">
        <?= $rimborsoVal!==null ? number_format((int)$rimborsoVal, 0, ',', '.') : '-' ?>
      </strong>
    </td>

    <td>
      <?php if ($r['match']==='OK'): ?>
        <span class="badge text-bg-success">OK</span>
      <?php else: ?>
        <span class="badge text-bg-danger">NON TROVATO</span>
      <?php endif; ?>
    </td>
  </tr>
<?php endforeach; ?>
</tbody>

            <tfoot class="table-secondary text-dark">
              <tr>
                <th colspan="8" class="text-end">Totale rimborso squadra</th>
                <th colspan="2"><strong><?= number_format((int)$tot, 0, ',', '.') ?></strong></th>
              </tr>
            </tfoot>
          </table>
        </div>

        <div class="sticky-summary d-flex justify-content-between align-items-center">
          <div>
            Selezionati: <strong id="selCount">0</strong>
          </div>
          <div>
            Totale selezionati: <strong id="selTotal">0</strong>
          </div>
          <div class="d-none d-md-inline">
            <button class="btn btn-sm btn-outline-light me-2" id="btnAll">Seleziona tutti</button>
            <button class="btn btn-sm btn-outline-light" id="btnNone">Deseleziona</button>
          </div>
        </div>

      </div>
    </div>
  <?php endif; ?>

  <footer class="text-center text-secondary small pb-5">© <?= date('Y') ?> NegherLeague — stile e colori dal logo.</footer>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script>
(function(){
  const fmt = new Intl.NumberFormat('it-IT');
  const checks = Array.from(document.querySelectorAll('.row-check'));
  const selTotalEl = document.getElementById('selTotal');
  const selCountEl = document.getElementById('selCount');
  const checkAll = document.getElementById('checkAll');
  const btnAll = document.getElementById('btnAll');
  const btnNone = document.getElementById('btnNone');

  function recalc(){
    let tot = 0, cnt = 0;
    checks.forEach(ch => {
      if (ch.checked && !ch.disabled) {
        cnt++;
        tot += parseInt(ch.dataset.rimborso || '0', 10);
      }
    });
    selCountEl.textContent = fmt.format(cnt);
    selTotalEl.textContent = fmt.format(tot);
  }

  checks.forEach(ch => ch.addEventListener('change', recalc));
  if (checkAll){
    checkAll.addEventListener('change', () => {
      checks.forEach(ch => { if (!ch.disabled) ch.checked = checkAll.checked; });
      recalc();
    });
  }
  if (btnAll){
    btnAll.addEventListener('click', (e)=>{ e.preventDefault(); checks.forEach(ch=>{ if(!ch.disabled) ch.checked=true; }); if(checkAll) checkAll.checked=true; recalc(); });
  }
  if (btnNone){
    btnNone.addEventListener('click', (e)=>{ e.preventDefault(); checks.forEach(ch=>{ ch.checked=false; }); if(checkAll) checkAll.checked=false; recalc(); });
  }
  recalc();
})();
</script>
</body>
</html>
