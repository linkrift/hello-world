const USERNAME_KEY = "trellix-username-v1";
const BOARD_ID = "main";

const boardEl = document.getElementById("board");
const masterContactsEl = document.getElementById("master-contacts");
const moduleTogglesEl = document.getElementById("module-toggles");
const addColumnBtn = document.getElementById("add-column-btn");
const renameUserBtn = document.getElementById("rename-user-btn");
const presenceEl = document.getElementById("presence");
const columnDialog = document.getElementById("column-dialog");
const columnForm = document.getElementById("column-form");
const columnTitleInput = document.getElementById("column-title");
const columnTemplate = document.getElementById("column-template");
const cardTemplate = document.getElementById("card-template");

let board = { modules: {}, columns: [] };
let username = getOrCreateUsername();
let revision = 0;
let eventSource;
let accessibleCards = [];

const DEFAULT_MODULES = {
  todo: true,
  notes: true,
  media: true,
  gating: true,
  rag: true,
  contacts: true
};

init().catch((error) => {
  console.error(error);
  presenceEl.textContent = "Connection failed";
});

async function init() {
  wireGlobalEvents();
  await loadInitialState();
  connectEvents();
}

function normalizeTodo(todo) {
  if (typeof todo === "string") return { id: crypto.randomUUID(), text: todo, checked: false, linkedCardId: "" };
  return {
    id: todo.id || crypto.randomUUID(),
    text: todo.text || "",
    checked: Boolean(todo.checked),
    linkedCardId: todo.linkedCardId || ""
  };
}

function normalizeCard(card) {
  return {
    id: card.id,
    text: card.text || "Untitled",
    completed: Boolean(card.completed),
    ragStatus: card.ragStatus || "red",
    todos: Array.isArray(card.todos) ? card.todos.map(normalizeTodo) : [],
    notes: typeof card.notes === "string" ? card.notes : "",
    media: Array.isArray(card.media) ? card.media : [],
    gatingCardIds: Array.isArray(card.gatingCardIds) ? card.gatingCardIds : [],
    contacts: Array.isArray(card.contacts) ? card.contacts : []
  };
}

function normalizeBoard(input) {
  const modules = { ...DEFAULT_MODULES, ...(input.modules || {}) };
  const columns = (input.columns || []).map((column) => ({
    ...column,
    cards: (column.cards || []).map(normalizeCard)
  }));
  return { modules, columns };
}

function allCards() {
  return board.columns.flatMap((column) => column.cards.map((card) => ({ ...card, columnId: column.id, columnTitle: column.title })));
}

function getOrCreateUsername() {
  const existing = localStorage.getItem(USERNAME_KEY);
  if (existing && existing.trim()) return existing.trim().slice(0, 30);

  const provided = window.prompt("Enter your display name:", "guest");
  const finalName = (provided || "guest").trim().slice(0, 30) || "guest";
  localStorage.setItem(USERNAME_KEY, finalName);
  return finalName;
}

async function loadInitialState() {
  const response = await fetch(`/api/state?boardId=${BOARD_ID}&username=${encodeURIComponent(username)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Failed to load state");

  board = normalizeBoard(payload.board);
  revision = payload.revision;

  await refreshAccessibleCards();
  render();
  presenceEl.textContent = `Connected · ${username}`;
}

function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/events?boardId=${BOARD_ID}&username=${encodeURIComponent(username)}`);

  eventSource.onopen = () => {
    presenceEl.classList.remove("offline");
  };

  eventSource.onmessage = async (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type !== "state") return;

    revision = payload.revision;
    board = normalizeBoard(payload.board);
    await refreshAccessibleCards();
    render();
    presenceEl.textContent = `Live · ${username} · updated by ${payload.updatedBy}`;
  };

  eventSource.onerror = () => {
    presenceEl.classList.add("offline");
    presenceEl.textContent = "Reconnecting...";
  };
}

async function refreshAccessibleCards() {
  const response = await fetch(`/api/cards?username=${encodeURIComponent(username)}`);
  const payload = await response.json();
  accessibleCards = payload.cards || [];
}

function renderModuleToggles() {
  moduleTogglesEl.innerHTML = "";
  for (const [moduleName, enabled] of Object.entries(board.modules)) {
    const label = document.createElement("label");
    label.className = "module-toggle";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(enabled);
    checkbox.addEventListener("change", async () => {
      board.modules[moduleName] = checkbox.checked;
      await persistAndRerender();
    });

    const text = document.createElement("span");
    text.textContent = moduleName;

    label.append(checkbox, text);
    moduleTogglesEl.append(label);
  }
}

function renderMasterContacts() {
  masterContactsEl.innerHTML = "";
  const seen = new Map();

  for (const card of allCards()) {
    for (const contact of card.contacts) {
      const key = `${(contact.name || "").trim().toLowerCase()}|${(contact.number || "").trim().toLowerCase()}`;
      if (!key || key === "|") continue;
      if (!seen.has(key)) seen.set(key, contact);
    }
  }

  if (!seen.size) {
    masterContactsEl.innerHTML = "<li class='muted'>No contacts yet</li>";
    return;
  }

  for (const contact of seen.values()) {
    const li = document.createElement("li");
    li.textContent = `${contact.name} · ${contact.number}${contact.company ? ` · ${contact.company}` : ""}`;
    masterContactsEl.append(li);
  }
}

function render() {
  boardEl.innerHTML = "";
  for (const column of board.columns) boardEl.append(createColumnElement(column));
  renderMasterContacts();
  renderModuleToggles();
}

function createColumnElement(column) {
  const fragment = columnTemplate.content.cloneNode(true);
  const columnEl = fragment.querySelector(".column");
  const titleEl = fragment.querySelector(".column-title");
  const cardListEl = fragment.querySelector(".card-list");
  const addCardFormEl = fragment.querySelector(".add-card-form");
  const cardInputEl = fragment.querySelector(".card-input");
  const deleteBtn = fragment.querySelector(".delete-column");

  columnEl.dataset.columnId = column.id;
  titleEl.textContent = column.title;

  for (const card of column.cards) cardListEl.append(createCardElement(column.id, card));

  addCardFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = cardInputEl.value.trim();
    if (!text) return;

    column.cards.push(normalizeCard({ id: crypto.randomUUID(), text }));
    cardInputEl.value = "";
    await persistAndRerender();
  });

  deleteBtn.addEventListener("click", async () => {
    board.columns = board.columns.filter((c) => c.id !== column.id);
    await persistAndRerender();
  });

  columnEl.addEventListener("dragstart", () => {
    columnEl.classList.add("dragging");
    columnEl.dataset.dragType = "column";
  });

  columnEl.addEventListener("dragend", async () => {
    columnEl.classList.remove("dragging");
    delete columnEl.dataset.dragType;
    syncColumnOrderFromDOM();
    await persistAndRerender();
  });

  cardListEl.addEventListener("dragover", (event) => {
    event.preventDefault();
    const draggingCard = document.querySelector(".card.dragging");
    if (!draggingCard) return;

    const afterEl = getDragAfterElement(cardListEl, event.clientY, ".card:not(.dragging)");
    if (!afterEl) cardListEl.append(draggingCard);
    else cardListEl.insertBefore(draggingCard, afterEl);
  });

  return fragment;
}

function cardLabelById(cardId) {
  const found = accessibleCards.find((c) => c.id === cardId);
  if (!found) return `Unknown (${cardId})`;
  return `${found.text} · ${found.boardName}/${found.columnTitle}`;
}

function createCardElement(columnId, card) {
  const fragment = cardTemplate.content.cloneNode(true);
  const cardEl = fragment.querySelector(".card");
  const folderEl = fragment.querySelector(".card-folder");
  const textEl = fragment.querySelector(".card-text");
  const expandBtn = fragment.querySelector(".expand-card");
  const completeBtn = fragment.querySelector(".complete-card");
  const ragSelect = fragment.querySelector(".rag-select");
  const closeFullscreenBtn = fragment.querySelector(".close-fullscreen");
  const deleteBtn = fragment.querySelector(".delete-card");

  const todoBlock = fragment.querySelector('[data-module="todo"]');
  const notesBlock = fragment.querySelector('[data-module="notes"]');
  const mediaBlock = fragment.querySelector('[data-module="media"]');
  const gatingBlock = fragment.querySelector('[data-module="gating"]');
  const contactsBlock = fragment.querySelector('[data-module="contacts"]');

  todoBlock.hidden = !board.modules.todo;
  notesBlock.hidden = !board.modules.notes;
  mediaBlock.hidden = !board.modules.media;
  gatingBlock.hidden = !board.modules.gating;
  contactsBlock.hidden = !board.modules.contacts;
  ragSelect.hidden = !board.modules.rag;

  const todoList = fragment.querySelector(".todo-list");
  const todoForm = fragment.querySelector(".todo-form");
  const todoInput = fragment.querySelector(".todo-input");
  const todoLinkSelect = fragment.querySelector(".todo-link-select");

  const notes = fragment.querySelector(".notes");

  const mediaList = fragment.querySelector(".media-list");
  const mediaUrlForm = fragment.querySelector(".media-url-form");
  const mediaInput = fragment.querySelector(".media-input");
  const mediaFileForm = fragment.querySelector(".media-file-form");
  const mediaFileInput = fragment.querySelector(".media-file-input");

  const gatingList = fragment.querySelector(".gating-list");
  const gatingForm = fragment.querySelector(".gating-form");
  const gatingSelect = fragment.querySelector(".gating-select");

  const contactList = fragment.querySelector(".contact-list");
  const contactForm = fragment.querySelector(".contact-form");

  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = columnId;
  textEl.textContent = card.text;
  ragSelect.value = card.ragStatus;

  completeBtn.textContent = card.completed ? "Completed ✅" : "Mark Complete";
  completeBtn.classList.toggle("btn-secondary", card.completed);

  todoLinkSelect.innerHTML = '<option value="">No linked card</option>';
  for (const optionCard of accessibleCards.filter((c) => c.id !== card.id)) {
    const opt = document.createElement("option");
    opt.value = optionCard.id;
    opt.textContent = `${optionCard.text} · ${optionCard.boardName}/${optionCard.columnTitle}`;
    todoLinkSelect.append(opt);
  }

  for (const todo of card.todos) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = Boolean(todo.checked);
    check.addEventListener("change", async () => {
      mutateCard(card.id, (target) => {
        const item = target.todos.find((entry) => entry.id === todo.id);
        if (item) item.checked = check.checked;
      });
      await persistAndRerender();
    });

    const text = document.createElement("span");
    text.textContent = todo.text;
    label.append(check, text);
    li.append(label);

    if (todo.linkedCardId) {
      const ref = document.createElement("small");
      ref.className = "muted";
      ref.textContent = ` ↳ ${cardLabelById(todo.linkedCardId)}`;
      li.append(ref);
    }

    todoList.append(li);
  }

  notes.value = card.notes;

  for (const mediaItem of card.media) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = mediaItem.url || mediaItem;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = mediaItem.name || mediaItem.url || mediaItem;
    li.append(a);
    mediaList.append(li);
  }

  gatingSelect.innerHTML = "";
  for (const optionCard of accessibleCards.filter((c) => c.id !== card.id)) {
    const opt = document.createElement("option");
    opt.value = optionCard.id;
    opt.textContent = `${optionCard.text} · ${optionCard.boardName}/${optionCard.columnTitle}`;
    gatingSelect.append(opt);
  }

  for (const gateId of card.gatingCardIds) {
    const li = document.createElement("li");
    li.textContent = cardLabelById(gateId);
    gatingList.append(li);
  }

  for (const contact of card.contacts) {
    const li = document.createElement("li");
    li.textContent = `${contact.name} · ${contact.number}${contact.role ? ` · ${contact.role}` : ""}`;
    contactList.append(li);
  }

  expandBtn.addEventListener("click", () => openCardFullscreen(cardEl, folderEl));
  closeFullscreenBtn.addEventListener("click", () => closeCardFullscreen(cardEl, folderEl));
  cardEl.addEventListener("dblclick", () => openCardFullscreen(cardEl, folderEl));

  completeBtn.addEventListener("click", async () => {
    const hasGates = card.gatingCardIds.length > 0;
    if (hasGates) {
      const response = window.confirm("This card has gating factors. Are all gating cards complete too?");
      if (response) {
        for (const gateId of card.gatingCardIds) {
          mutateCard(gateId, (target) => { target.completed = true; });
        }
      }
    }

    mutateCard(card.id, (target) => { target.completed = true; });
    await persistAndRerender();
  });

  ragSelect.addEventListener("change", async () => {
    mutateCard(card.id, (target) => { target.ragStatus = ragSelect.value; });
    await persistAndRerender();
  });

  deleteBtn.addEventListener("click", async () => {
    const source = board.columns.find((c) => c.id === columnId);
    source.cards = source.cards.filter((entry) => entry.id !== card.id);

    for (const column of board.columns) {
      for (const entry of column.cards) {
        entry.gatingCardIds = entry.gatingCardIds.filter((id) => id !== card.id);
      }
    }

    await persistAndRerender();
  });

  todoForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = todoInput.value.trim();
    if (!value) return;

    mutateCard(card.id, (target) => {
      target.todos.push({
        id: crypto.randomUUID(),
        text: value,
        checked: false,
        linkedCardId: todoLinkSelect.value || ""
      });
    });

    todoInput.value = "";
    await persistAndRerender();
  });

  notes.addEventListener("change", async () => {
    mutateCard(card.id, (target) => { target.notes = notes.value; });
    await persistAndRerender();
  });

  mediaUrlForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = mediaInput.value.trim();
    if (!value) return;

    mutateCard(card.id, (target) => {
      target.media.push({ id: crypto.randomUUID(), type: "url", name: value, url: value });
    });

    mediaInput.value = "";
    await persistAndRerender();
  });

  mediaFileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = mediaFileInput.files[0];
    if (!file) return;

    const uploadResponse = await fetch(`/api/upload?boardId=${BOARD_ID}&username=${encodeURIComponent(username)}`, {
      method: "POST",
      headers: {
        "x-filename": file.name,
        "content-type": file.type || "application/octet-stream"
      },
      body: await file.arrayBuffer()
    });

    const payload = await uploadResponse.json();
    if (!uploadResponse.ok) throw new Error(payload.error || "Upload failed");

    mutateCard(card.id, (target) => {
      target.media.push({ id: crypto.randomUUID(), type: "file", name: payload.name, url: payload.url });
    });

    mediaFileInput.value = "";
    await persistAndRerender();
  });

  gatingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!gatingSelect.value) return;

    mutateCard(card.id, (target) => {
      if (!target.gatingCardIds.includes(gatingSelect.value)) target.gatingCardIds.push(gatingSelect.value);
    });

    await persistAndRerender();
  });

  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const get = (selector) => contactForm.querySelector(selector).value.trim();
    const name = get(".contact-name");
    const number = get(".contact-number");
    if (!name || !number) return;

    mutateCard(card.id, (target) => {
      target.contacts.push({
        id: crypto.randomUUID(),
        name,
        number,
        role: get(".contact-role"),
        company: get(".contact-company"),
        email: get(".contact-email"),
        birthday: contactForm.querySelector(".contact-birthday").value,
        rating: get(".contact-rating"),
        notes: get(".contact-notes")
      });
    });

    contactForm.reset();
    await persistAndRerender();
  });

  cardEl.addEventListener("dragstart", () => cardEl.classList.add("dragging"));
  cardEl.addEventListener("dragend", async () => {
    cardEl.classList.remove("dragging");
    syncCardsFromDOM();
    await persistAndRerender();
  });

  return fragment;
}


function openCardFullscreen(cardEl, folderEl) {
  closeAllFullscreenCards();
  cardEl.classList.add("fullscreen");
  folderEl.classList.remove("hidden");
  folderEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("has-fullscreen-card");
}

function closeCardFullscreen(cardEl, folderEl) {
  cardEl.classList.remove("fullscreen");
  folderEl.classList.add("hidden");
  folderEl.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".card.fullscreen")) {
    document.body.classList.remove("has-fullscreen-card");
  }
}

function closeAllFullscreenCards() {
  for (const openCard of document.querySelectorAll('.card.fullscreen')) {
    openCard.classList.remove('fullscreen');
    const folder = openCard.querySelector('.card-folder');
    if (folder) {
      folder.classList.add('hidden');
      folder.setAttribute('aria-hidden', 'true');
    }
  }
  document.body.classList.remove('has-fullscreen-card');
}

function mutateCard(cardId, updater) {
  for (const column of board.columns) {
    const card = column.cards.find((entry) => entry.id === cardId);
    if (card) {
      updater(card);
      return;
    }
  }
}

function syncColumnOrderFromDOM() {
  const orderedIds = [...boardEl.querySelectorAll(".column")].map((el) => el.dataset.columnId);
  board.columns.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
}

function syncCardsFromDOM() {
  const columnEls = [...boardEl.querySelectorAll(".column")];
  for (const columnEl of columnEls) {
    const columnId = columnEl.dataset.columnId;
    const cards = [...columnEl.querySelectorAll(".card")].map((cardEl) => findCardById(cardEl.dataset.cardId));
    const column = board.columns.find((entry) => entry.id === columnId);
    column.cards = cards;
  }
}

function findCardById(cardId) {
  for (const column of board.columns) {
    const card = column.cards.find((entry) => entry.id === cardId);
    if (card) return card;
  }
  throw new Error(`Card not found: ${cardId}`);
}

function wireGlobalEvents() {
  addColumnBtn.addEventListener("click", () => {
    columnTitleInput.value = "";
    columnDialog.showModal();
    columnTitleInput.focus();
  });

  renameUserBtn.addEventListener("click", () => {
    const provided = window.prompt("Enter a new display name:", username);
    if (!provided) return;
    username = provided.trim().slice(0, 30) || username;
    localStorage.setItem(USERNAME_KEY, username);
    connectEvents();
  });

  columnForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = columnTitleInput.value.trim();
    if (!title) return;

    board.columns.push({ id: crypto.randomUUID(), title, cards: [] });
    columnDialog.close();
    await persistAndRerender();
  });

  boardEl.addEventListener("dragover", (event) => {
    event.preventDefault();
    const draggingColumn = document.querySelector(".column.dragging");
    if (!draggingColumn || draggingColumn.dataset.dragType !== "column") return;

    const afterEl = getDragAfterElement(boardEl, event.clientX, ".column:not(.dragging)", true);
    if (!afterEl) boardEl.append(draggingColumn);
    else boardEl.insertBefore(draggingColumn, afterEl);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAllFullscreenCards();
  });
}


function getDragAfterElement(container, position, selector, horizontal = false) {
  const draggableElements = [...container.querySelectorAll(selector)];
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = horizontal
      ? position - box.left - box.width / 2
      : position - box.top - box.height / 2;

    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

async function persistAndRerender() {
  render();
  const response = await fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ boardId: BOARD_ID, board, username, revision })
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Failed to sync board state");

  revision = payload.revision;
  await refreshAccessibleCards();
}
