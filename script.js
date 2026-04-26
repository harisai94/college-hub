const notesContainer = document.getElementById('notes-container');
const deptFilter = document.getElementById('dept-filter');
const semFilter = document.getElementById('sem-filter');
const searchBar = document.getElementById('search-bar');
const resultsCount = document.getElementById('results-count');

const uploadModal = document.getElementById('upload-modal');
const openUploadBtn = document.getElementById('open-upload-btn');
const closeModalBtn = document.getElementById('close-modal-btn');
const uploadForm = document.getElementById('upload-form');
const logoutBtn = document.getElementById('logout-btn');
const profileChip = document.getElementById('profile-chip');

const entryOverlay = document.getElementById('entry-overlay');
const entryForm = document.getElementById('entry-form');
const displayNameInput = document.getElementById('display-name');
const accessCodeInput = document.getElementById('access-code');
const entryNote = document.getElementById('entry-note');

let allNotes = [];
let currentUser = null;
let sessionToken = null;
let notesEventSource = null;

async function parseJsonSafe(res) {
    const raw = await res.text();
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch (_err) {
        throw new Error('Server returned an invalid response. Start the app with npm start and open http://localhost:3000.');
    }
}

function getFileIcon(type) {
    return type === 'pdf' ? ['fa-file-pdf', '#ef4444'] : ['fa-file-word', '#2563eb'];
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderNotes(notes) {
    notesContainer.innerHTML = '';

    if (!notes.length) {
        notesContainer.innerHTML = '<p style="color: var(--text-muted);">No notes found for this repository.</p>';
        resultsCount.innerText = '0 results';
        return;
    }

    notes.forEach((note) => {
        const card = document.createElement('div');
        card.className = 'note-card';
        const [iconClass, iconColor] = getFileIcon(note.fileType);
        const downloadLink = note.filePath ? `<a class="card-action-btn download-btn" href="${note.filePath}" target="_blank" rel="noopener noreferrer" title="Download file"><i class="fa-solid fa-download"></i></a>` : '';
        const deleteBtn = `<button type="button" class="card-action-btn delete-btn" data-note-id="${note.id}" title="Delete note"><i class="fa-solid fa-trash"></i></button>`;

        card.innerHTML = `
            <div class="card-icon" style="color: ${iconColor}">
                <i class="fa-regular ${iconClass}"></i>
            </div>
            <h3 class="card-title">${note.title}</h3>
            <div class="card-tags">
                <span class="tag">${note.department}</span>
                <span class="tag">${note.semester}</span>
            </div>
            <p class="card-note">${note.noteText ? note.noteText : 'No text note added.'}</p>
            <div class="card-footer">
                <span>By ${note.uploaderName} • ${formatDate(note.createdAt)}</span>
                <div class="card-actions">
                    ${downloadLink}
                    ${deleteBtn}
                </div>
            </div>
        `;
        notesContainer.appendChild(card);
    });

    resultsCount.innerText = `Showing ${notes.length} notes`;
}

function applyFilters() {
    const deptValue = deptFilter.value;
    const semValue = semFilter.value;
    const searchValue = searchBar.value.trim().toLowerCase();

    const filteredNotes = allNotes.filter((note) => {
        const matchesDept = deptValue === 'All' || note.department === deptValue;
        const matchesSem = semValue === 'All' || note.semester === semValue;
        const matchesSearch = note.title.toLowerCase().includes(searchValue);
        return matchesDept && matchesSem && matchesSearch;
    });

    renderNotes(filteredNotes);
}

async function loadNotes() {
    const res = await fetch('/api/notes', {
        headers: { 'x-session-token': sessionToken }
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) {
        throw new Error(data.message || 'Failed to load notes.');
    }
    allNotes = data.notes || [];
    applyFilters();
}

function stopRealtimeUpdates() {
    if (notesEventSource) {
        notesEventSource.close();
        notesEventSource = null;
    }
}

function startRealtimeUpdates() {
    stopRealtimeUpdates();
    if (!sessionToken) return;

    const streamUrl = `/api/notes/stream?token=${encodeURIComponent(sessionToken)}`;
    notesEventSource = new EventSource(streamUrl);

    notesEventSource.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data || '{}');
            if (data.type === 'note-added' || data.type === 'note-deleted') {
                await loadNotes();
            }
        } catch (_err) {
            // Ignore malformed stream events.
        }
    };

    notesEventSource.onerror = () => {
        stopRealtimeUpdates();
        if (sessionToken) {
            // EventSource auto-retry can be unreliable after some proxy drops.
            setTimeout(startRealtimeUpdates, 1500);
        }
    };
}

function showMessage(text, isError = false) {
    entryNote.innerText = text;
    entryNote.style.color = isError ? '#dc2626' : '#16a34a';
}

async function openRepository(e) {
    e.preventDefault();
    const payload = {
        code: accessCodeInput.value,
        displayName: displayNameInput.value
    };

    try {
        const res = await fetch('/api/session/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await parseJsonSafe(res);

        if (!res.ok) {
            throw new Error(data.message || `Unable to open repository (HTTP ${res.status}). Please verify your code and try again.`);
        }

        currentUser = data.user;
        sessionToken = data.token;
        allNotes = data.notes;
        profileChip.title = `${currentUser.displayName}`;
        showMessage(data.created ? 'New repository created successfully.' : 'Repository opened successfully.');

        setTimeout(() => {
            entryOverlay.style.display = 'none';
            applyFilters();
            startRealtimeUpdates();
        }, 350);
    } catch (error) {
        showMessage(error.message, true);
    }
}

async function uploadNote(e) {
    e.preventDefault();
    const formData = new FormData();
    formData.append('title', document.getElementById('note-title').value);
    formData.append('department', document.getElementById('note-department').value);
    formData.append('semester', document.getElementById('note-semester').value);
    formData.append('noteText', document.getElementById('note-text').value);

    const fileInput = document.getElementById('note-file');
    if (fileInput.files[0]) {
        formData.append('file', fileInput.files[0]);
    }

    try {
        const res = await fetch('/api/notes', {
            method: 'POST',
            headers: { 'x-session-token': sessionToken },
            body: formData
        });
        const data = await parseJsonSafe(res);
        if (!res.ok) {
            throw new Error(data.message || 'Upload failed');
        }

        uploadForm.reset();
        uploadModal.style.display = 'none';
        await loadNotes();
    } catch (error) {
        alert(error.message);
    }
}

async function deleteNote(noteId) {
    const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}`, {
        method: 'DELETE',
        headers: { 'x-session-token': sessionToken }
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) {
        throw new Error(data.message || 'Delete failed');
    }
}

async function logout() {
    stopRealtimeUpdates();
    if (sessionToken) {
        await fetch('/api/session/logout', {
            method: 'POST',
            headers: { 'x-session-token': sessionToken }
        });
    }
    currentUser = null;
    sessionToken = null;
    allNotes = [];
    notesContainer.innerHTML = '';
    entryOverlay.style.display = 'flex';
    accessCodeInput.value = '';
    showMessage('Session ended.');
}

deptFilter.addEventListener('change', applyFilters);
semFilter.addEventListener('change', applyFilters);
searchBar.addEventListener('input', applyFilters);

openUploadBtn.addEventListener('click', () => {
    uploadModal.style.display = 'flex';
});

closeModalBtn.addEventListener('click', () => {
    uploadModal.style.display = 'none';
});

window.addEventListener('click', (e) => {
    if (e.target === uploadModal) {
        uploadModal.style.display = 'none';
    }
});

notesContainer.addEventListener('click', async (e) => {
    const deleteButton = e.target.closest('.delete-btn');
    if (!deleteButton) return;

    const noteId = deleteButton.dataset.noteId;
    if (!noteId) return;

    const shouldDelete = window.confirm('Delete this note and uploaded file permanently?');
    if (!shouldDelete) return;

    deleteButton.disabled = true;
    try {
        await deleteNote(noteId);
        await loadNotes();
    } catch (error) {
        alert(error.message);
    } finally {
        deleteButton.disabled = false;
    }
});

entryForm.addEventListener('submit', openRepository);
uploadForm.addEventListener('submit', uploadNote);
logoutBtn.addEventListener('click', logout);
