import { esc, fmtBytes, orbit, toast } from '../shared.js';

const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const gallery = document.getElementById('gallery');
const lastEl = document.getElementById('last');
const countEl = document.getElementById('count');

async function refresh() {
  const { data } = await orbit({ query: 'image { id, filename, size, type, url }' });
  gallery.innerHTML = '';
  const images = data ?? [];
  if (images.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-gallery';
    empty.textContent = 'No images yet — drop one above ☝️';
    gallery.appendChild(empty);
  }
  for (const image of images) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    // The server owns the stored file name — the client never reconstructs it.
    const url = image.url ?? `/uploads/${image.id}`;
    tile.innerHTML = `
      <img src="${url}" alt="${esc(image.filename)}" loading="lazy" />
      <button class="remove" title="Remove ${esc(image.filename)}" data-id="${esc(image.id)}">✕</button>
      <div class="meta">
        <div class="name" title="${esc(image.filename)}">${esc(image.filename)}</div>
        <div>${fmtBytes(image.size)} · ${esc(image.type || '—')}</div>
      </div>`;
    gallery.appendChild(tile);
  }
  countEl.textContent = String(images.length);
}

async function uploadFile(file) {
  if (!file.type.startsWith('image/')) {
    toast(`'${file.name}' is not an image`, true);
    return;
  }
  drop.classList.add('busy');
  try {
    const form = new FormData();
    form.set('envelope', JSON.stringify({ do: 'image.upload', args: {} }));
    form.set('upload', file);

    const res = await fetch('/orbit', { method: 'POST', body: form });
    const body = await res.json();
    if (body.error) {
      toast(`${body.error.code}: ${body.error.message}`, true);
      return;
    }
    lastEl.textContent = `${file.name} · ${fmtBytes(file.size)} · ${fmtBytes(Number(res.headers.get('content-length')) || 0)} wire`;
    lastEl.classList.add('good');
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    drop.classList.remove('busy');
  }
}

async function handleFiles(files) {
  for (const file of files) await uploadFile(file);
}

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleFiles([...fileInput.files]));
drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('dragging');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('dragging');
  handleFiles([...event.dataTransfer.files]);
});

gallery.addEventListener('click', async (event) => {
  const button = event.target.closest('.remove');
  if (!button) return;
  try {
    await orbit({
      do: 'image.remove',
      args: { filter: { id: button.dataset.id } },
    });
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
});

refresh().catch((error) => toast(error.message, true));
