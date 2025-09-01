<?php
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '1');

/* Autoload */
$autoloads = [
  __DIR__ . '/../vendor/autoload.php',
  __DIR__ . '/../../vendor/autoload.php',
];
$autoload = null;
foreach ($autoloads as $a) if (file_exists($a)) { $autoload = $a; break; }
if (!$autoload) { fwrite(STDERR, "ERRORE: vendor/autoload.php non trovato. Esegui: composer require phpoffice/phpspreadsheet\n"); exit(1); }
require $autoload;

use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx;
use PhpOffice\PhpSpreadsheet\Cell\Coordinate;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;
use PhpOffice\PhpSpreadsheet\Style\Alignment;
use PhpOffice\PhpSpreadsheet\Style\Border;
use PhpOffice\PhpSpreadsheet\Style\Fill;

$SRC = __DIR__ . '/../cache/rose_leghe.xlsx';
$OUT = __DIR__ . '/../negher rosters.xlsx';
if (!file_exists($SRC)) { fwrite(STDERR, "ERRORE: sorgente non trovato: $SRC\n"); exit(1); }

/* ---------------- Utils ---------------- */
function norm(string $s): string {
  $s = str_replace(["\u{00A0}", "’"], [' ', "'"], $s);
  return trim(preg_replace('/\s+/u', ' ', $s));
}
function isRoleToken(string $v): bool {
  $v = strtoupper(norm($v));
  if ($v === '') return false;
  $tok = '(POR|DS|DD|DC|E|M|C|W|T|A|PC|P|D)'; // Mantra/Classic + combinazioni con ;
  return (bool)preg_match("/^$tok(?:;$tok)*$/", $v);
}
function isNumericLike(string $s): bool {
  return (bool)preg_match('/^\s*[\d\.,]+\s*$/', $s);
}
function isLikelyPlayer(string $s): bool {
  $s = norm($s);
  if ($s === '' || isNumericLike($s)) return false;
  // ha almeno una lettera e > 2 char
  if (!preg_match('/[A-Za-zÀ-ÿ]/u', $s)) return false;
  // di solito contiene almeno uno spazio (nome cognome) o apostrofo/punto
  return (bool)preg_match('/[\s\'.-]/u', $s) || mb_strlen($s) >= 4;
}
function isLikelyTeam(string $s): bool {
  $s = strtoupper(norm($s));
  if ($s === '' || isNumericLike($s)) return false;
  // spesso 2-4 lettere (ATA, BOL, MIL, INT...) o team completi (ATALANTA)
  return (mb_strlen($s) <= 12);
}
function toNumber(?string $s): ?float {
  $s = str_replace(',', '.', preg_replace('/[^\d,.\-]/', '', (string)$s));
  if ($s === '') return null;
  return (float)$s;
}
function cell(Worksheet $ws, int $c, int $r): string {
  return norm((string)$ws->getCellByColumnAndRow($c, $r)->getValue());
}

/** Header tabella lunga classica (se esiste). */
function findHeaderMap(Worksheet $ws, int $maxRows = 80, int $maxCols = 80): ?array {
  $maxR = min($maxRows, $ws->getHighestRow());
  $maxC = min($maxCols, Coordinate::columnIndexFromString($ws->getHighestColumn()));
  for ($r = 1; $r <= $maxR; $r++) {
    $map = [];
    for ($c = 1; $c <= $maxC; $c++) {
      $val = strtolower(cell($ws, $c, $r));
      if ($val === '') continue;
      if (preg_match('/\b(ruolo|r)\b/', $val)) $map['ruolo'] = $c;
      if (preg_match('/\b(calciatore|giocatore)\b/', $val) || (!isset($map['nome']) && $val === 'nome')) $map['nome'] = $c;
      if ((preg_match('/\b(squadra|club|team)\b/', $val) && !preg_match('/fanta/', $val))) $map['squadra'] = $c;
      if (preg_match('/(costo|prezzo|pagat|acquisto|spesa|valore|quot|qt)\b/', $val)) $map['costo'] = $c;
      if (preg_match('/(fanta.*squadra|squadra.*fanta|fantasquadra|rosa|partecipante|fantallenatore)/', $val)) $map['fantasquadra'] = $c;
    }
    if (isset($map['ruolo'], $map['nome'], $map['squadra'], $map['costo'])) {
      $map['header_row'] = $r;
      return $map;
    }
  }
  return null;
}

/** Heuristica blocchi 4-col senza header (accetta Ruolo vuoto). */
function scanBlocksHeuristic(Worksheet $ws, array &$outTeams, array &$debug): int {
  $maxR = min(800, $ws->getHighestRow());
  $maxC = min(200, Coordinate::columnIndexFromString($ws->getHighestColumn()));
  $blocks = 0;

  for ($r = 1; $r <= $maxR; $r++) {
    for ($c = 1; $c <= $maxC - 3; $c++) {
      // Valuta fino a 80 righe come “finestra” del blocco
      $valid = 0; $rowsChecked = 0;
      for ($k = 1; $k <= 80 && ($r + $k) <= $maxR; $k++) {
        $ruolo   = cell($ws, $c,     $r + $k);   // può essere vuoto/icone
        $player  = cell($ws, $c + 1, $r + $k);
        $squadra = cell($ws, $c + 2, $r + $k);
        $costo   = cell($ws, $c + 3, $r + $k);

        if ($ruolo === '' && $player === '' && $squadra === '' && $costo === '') {
          // consentiamo salti iniziali; stop dopo 5 vuote consecutive se avevamo già match
          if ($valid > 0) { $rowsChecked++; if ($rowsChecked >= 5) break; }
          continue;
        }
        $rowsChecked = 0;

        // Requisiti minimi: player plausibile, costo numerico, squadra plausibile
        if (!isLikelyPlayer($player)) break;
        if (!isNumericLike($costo)) break;
        if ($squadra !== '' && !isLikelyTeam($squadra)) break;

        // Ruolo: accettiamo vuoto o token valido
        if ($ruolo !== '' && !isRoleToken($ruolo)) break;

        $valid++;
      }

      // Se troviamo almeno 5-6 righe valide, consideriamolo un blocco
      if ($valid >= 5) {
        // Nome fantasquadra: cerca sulla riga sopra (fino a 6 su)
        $team = '';
        for ($up = 1; $up <= 6; $up++) {
          $cand = cell($ws, $c, $r - $up);
          if ($cand !== '' && !isRoleToken($cand) && !preg_match('/^(totale|crediti|residui|ruolo)$/i', $cand) && !isNumericLike($cand)) {
            $team = $cand; break;
          }
        }
        if ($team === '') $team = norm((string)$ws->getTitle());

        // Estrai effettivamente i dati “giù” fino a rottura
        $row = $r + 1; $emptyStreak = 0; $rowsAdded = 0;
        while ($row <= $maxR) {
          $ruolo   = cell($ws, $c,     $row);
          $player  = cell($ws, $c + 1, $row);
          $squadra = cell($ws, $c + 2, $row);
          $costo   = cell($ws, $c + 3, $row);

          if ($ruolo === '' && $player === '' && $squadra === '' && $costo === '') {
            $emptyStreak++;
            if ($emptyStreak >= 3) break;
            $row++; continue;
          } else $emptyStreak = 0;

          // fermati se salta il pattern base
          if (!isLikelyPlayer($player) || !isNumericLike($costo)) break;

          if (!preg_match('/^crediti|^totale|^residui/i', $player)) {
            $outTeams[$team][] = [
              'ruolo'   => strtoupper($ruolo),  // può essere ''
              'player'  => $player,
              'squadra' => $squadra,
              'costo'   => toNumber($costo),
            ];
            $rowsAdded++;
          }
          $row++;
        }

        if ($rowsAdded >= 4) {
          $blocks++;
          $debug[] = sprintf("Block @%s!R%dC%d -> team '%s' rows=%d", $ws->getTitle(), $r, $c, $team, $rowsAdded);
          // salta le 3 colonne successive per non rimatchare lo stesso blocco
          $c += 3;
        }
      }
    }
  }
  return $blocks;
}

/* ---------------- PARSING ---------------- */
$xl = IOFactory::load($SRC);
$teams = [];
$debug = [];
$blocksFound = 0;

// 1) Prova per blocchi “senza header” (tipico FANTA-ASTA con icone)
foreach ($xl->getWorksheetIterator() as $ws) {
  $blocksFound += scanBlocksHeuristic($ws, $teams, $debug);
}

// 2) Se non trova blocchi, prova la tabella lunga classica (con header testuali)
if ($blocksFound === 0) {
  foreach ($xl->getWorksheetIterator() as $ws) {
    $map = findHeaderMap($ws);
    if (!$map) continue;
    $r0 = $map['header_row'] + 1;
    $maxR = $ws->getHighestRow();
    for ($r = $r0; $r <= $maxR; $r++) {
      $ruolo   = cell($ws, $map['ruolo'],   $r);
      $player  = cell($ws, $map['nome'],    $r);
      $squadra = cell($ws, $map['squadra'], $r);
      $costo   = cell($ws, $map['costo'],   $r);
      if ($ruolo === '' && $player === '' && $squadra === '' && $costo === '') continue;
      $teamName = isset($map['fantasquadra']) ? cell($ws, $map['fantasquadra'], $r) : norm((string)$ws->getTitle());
      if ($teamName === '' || isRoleToken($teamName) || isNumericLike($teamName)) continue;
      $teams[$teamName][] = [
        'ruolo'   => strtoupper($ruolo),
        'player'  => $player,
        'squadra' => $squadra,
        'costo'   => toNumber($costo),
      ];
    }
  }
}

if (!$teams) {
  if ($debug) fwrite(STDERR, "DEBUG blocks:\n".implode("\n", $debug)."\n");
  fwrite(STDERR, "ERRORE: nessuna riga valida dall'export.\n");
  exit(2);
}

/* ---------------- SCRITTURA “TutteLeRose” ---------------- */
$ss = new Spreadsheet();
$sh = $ss->getActiveSheet();
$sh->setTitle('TutteLeRose');

$headStyle = [
  'font' => ['bold' => true],
  'alignment' => ['horizontal' => Alignment::HORIZONTAL_CENTER],
  'borders' => ['bottom' => ['borderStyle' => Border::BORDER_THIN]],
  'fill' => ['fillType' => Fill::FILL_SOLID, 'startColor' => ['rgb' => 'F2F2F2']],
];

// Ordina alfabeticamente
uksort($teams, fn($a,$b)=>strcasecmp($a,$b));

$col = 1;
$summary = [];
foreach ($teams as $teamName => $rows) {
  $rows = array_values(array_filter($rows, fn($r)=>($r['player'] ?? '') !== ''));
  if (!$rows) continue;

  $summary[] = sprintf("- %s: %d righe", $teamName, count($rows));

  $sh->mergeCellsByColumnAndRow($col, 1, $col + 3, 1);
  $sh->setCellValueByColumnAndRow($col, 1, $teamName);
  $sh->getStyleByColumnAndRow($col, 1)->getFont()->setBold(true);
  $sh->getStyleByColumnAndRow($col, 1)->getAlignment()->setHorizontal(Alignment::HORIZONTAL_CENTER);

  foreach (['Ruolo','Calciatore','Squadra','Costo'] as $i => $h) {
    $sh->setCellValueByColumnAndRow($col + $i, 2, $h);
    $sh->getStyleByColumnAndRow($col + $i, 2)->applyFromArray($headStyle);
  }

  $r = 3;
  foreach ($rows as $it) {
    $sh->setCellValueByColumnAndRow($col,     $r, (string)($it['ruolo'] ?? ''));
    $sh->setCellValueByColumnAndRow($col + 1, $r, (string)($it['player'] ?? ''));
    $sh->setCellValueByColumnAndRow($col + 2, $r, (string)($it['squadra'] ?? ''));
    if (isset($it['costo']) && $it['costo'] !== null && $it['costo'] !== '') {
      $sh->setCellValueExplicitByColumnAndRow($col + 3, $r, (float)$it['costo'], \PhpOffice\PhpSpreadsheet\Cell\DataType::TYPE_NUMERIC);
    }
    $r++;
  }

  $sh->getColumnDimensionByColumn($col    )->setWidth(8);
  $sh->getColumnDimensionByColumn($col + 1)->setWidth(28);
  $sh->getColumnDimensionByColumn($col + 2)->setWidth(16);
  $sh->getColumnDimensionByColumn($col + 3)->setWidth(10);

  $col += 4;
}

$sh->freezePaneByColumnAndRow(1, 3);
$writer = new Xlsx($ss);
$writer->save($OUT);

echo "OK: creato \"$OUT\" da \"$SRC\" (", count($teams), " squadre)\n";
echo "Dettaglio:\n", implode("\n", $summary), "\n";
