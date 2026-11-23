// lib/storage.js — атомарная запись и чтение JSON-состояния
'use strict';
const fs   = require('fs');
const path = require('path');

/**
 * Читает JSON. Отсутствие файла — это не ошибка (missing: true).
 * Битый JSON — исключение: файл переименовывается в .corrupt-<ts>,
 * чтобы его нельзя было молча перезаписать пустым состоянием.
 *
 * @param {string} file
 * @returns {{missing: true, data: null} | {missing: false, data: any}}
 */
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true, data: null };
    throw err;
  }
  try {
    return { missing: false, data: JSON.parse(raw) };
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    let moved = false;
    try { fs.renameSync(file, backup); moved = true; } catch { /* оставляем файл на месте */ }
    err.message = `Повреждён JSON: ${file}${moved ? ` (сохранён как ${path.basename(backup)})` : ''}: ${err.message}`;
    throw err;
  }
}

/**
 * Атомарная запись JSON: tmp + fsync + rename.
 * Прерывание процесса на любом шаге оставляет либо старый, либо новый файл,
 * но никогда не пишет половину.
 *
 * @param {string} file
 * @param {any} data
 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJsonAtomic };
