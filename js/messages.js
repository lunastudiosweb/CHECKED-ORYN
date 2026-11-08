// =========================================================
// CHECKED ORYN — Direct messages (1-to-1)
// Requires supabase/messages.sql (and servers.sql for the
// image bucket) to have been run once.
// =========================================================

const db = window.supabaseClient;

const ATTACHMENT_BUCKET = "server-attachments";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILE_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp"
};

const state = {
    me: null,
    conversations: [],       // { id, user_a, user_b, other, last }
    activeId: null,
    profiles: new Map(),
    pendingFile: null,
    realtime: null,
    sending: false,
    nicknames: new Map(),    // user id -> nickname only I can see
    typingChannel: null,
    typingTimer: null,
    lastTypingSent: 0
};

const $ = id => document.getElementById(id);

function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

const app = $("srvApp");
const messageList = $("messageList");
const composer = $("composer");
const messageInput = $("messageInput");

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

function nameOf(id) {
    if (id !== state.me?.id && state.nicknames.has(id)) return state.nicknames.get(id);

    const p = state.profiles.get(id);
    return p?.display_name || p?.username || "Unknown user";
}

function handleOf(id) {
    const p = state.profiles.get(id);
    return p?.username ? "@" + p.username : "";
}

function initialOf(id) {
    return nameOf(id).charAt(0).toUpperCase();
}

function errorText(error) {
    const text = error?.message || "Something went wrong.";

    if (/relation .* does not exist|schema cache|Could not find the (table|function)/i.test(text)) {
        return "Messages aren't set up in Supabase yet. Run supabase/messages.sql in the SQL Editor.";
    }

    return text;
}

let toastTimer = null;
function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

function formatTime(date) {
    const d = new Date(date);
    const sameDay = d.toDateString() === new Date().toDateString();

    return sameDay
        ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function preview(message) {
    if (!message) return "No messages yet";
    const prefix = message.sender_id === state.me.id ? "You: " : "";
    const text = (message.content || "").trim();
    return prefix + (text || "📷 Image");
}

function otherId(conv) {
    return conv.user_a === state.me.id ? conv.user_b : conv.user_a;
}

function remember(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* unavailable */ }
}

function recall(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

function closeModals() {
    document.querySelectorAll(".modal-backdrop").forEach(m => { m.hidden = true; });
    hideDmMenu();
}

document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("mousedown", event => {
        if (event.target === backdrop) closeModals();
    });
});

document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closeModals));
$("lightbox").addEventListener("click", closeModals);
document.addEventListener("keydown", event => {
    if (event.key === "Escape") { closeModals(); hideResults(); }
});

function openLightbox(url, alt) {
    $("lightboxImg").src = url;
    $("lightboxImg").alt = alt || "Image";
    $("lightbox").hidden = false;
}

// ---------------------------------------------------------
// DATA
// ---------------------------------------------------------

async function loadProfiles(ids) {
    const missing = [...new Set(ids)].filter(id => id && !state.profiles.has(id));
    if (missing.length === 0) return;

    const { data, error } = await db
        .from("profiles")
        .select("id, username, display_name")
        .in("id", missing);

    if (error) {
        console.error("Profiles error:", error);
        return;
    }

    (data || []).forEach(p => state.profiles.set(p.id, p));
}

async function loadConversations() {
    const { data, error } = await db
        .from("dm_conversations")
        .select("id, user_a, user_b, created_at");

    if (error) {
        console.error("Conversations error:", error);
        messageList.replaceChildren(el("div", "list-note", errorText(error)));
        return false;
    }

    const conversations = data || [];

    await loadProfiles(conversations.map(otherId));

    // Latest message of each conversation, for the preview + ordering.
    const lastByConv = new Map();

    if (conversations.length > 0) {
        const { data: recent, error: recentError } = await db
            .from("dm_messages")
            .select("id, conversation_id, sender_id, content, attachment_url, created_at")
            .in("conversation_id", conversations.map(c => c.id))
            .order("created_at", { ascending: false })
            .limit(300);

        if (recentError) console.error("Recent messages error:", recentError);

        (recent || []).forEach(m => {
            if (!lastByConv.has(m.conversation_id)) lastByConv.set(m.conversation_id, m);
        });
    }

    state.conversations = conversations
        .map(c => ({ ...c, other: otherId(c), last: lastByConv.get(c.id) || null }))
        .sort((a, b) =>
            new Date(b.last?.created_at || b.created_at) - new Date(a.last?.created_at || a.created_at)
        );

    renderConversations();
    return true;
}

async function loadMessages() {
    const convId = state.activeId;
    if (!convId) return;

    messageList.replaceChildren(el("div", "list-note", "Loading messages…"));

    const { data, error } = await db
        .from("dm_messages")
        .select("id, conversation_id, sender_id, content, attachment_url, attachment_type, attachment_name, created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: false })
        .limit(100);

    if (convId !== state.activeId) return;

    if (error) {
        console.error("Messages error:", error);
        messageList.replaceChildren(el("div", "list-note", errorText(error)));
        return;
    }

    const messages = (data || []).reverse();

    messageList.replaceChildren();

    const other = activeConversation()?.other;
    const intro = el("div", "list-intro");
    intro.append(
        el("h2", "", nameOf(other)),
        el("p", "", `This is the beginning of your conversation with ${handleOf(other) || nameOf(other)}.`)
    );
    messageList.append(intro);

    messages.forEach(m => messageList.append(buildMessage(m)));
    scrollToBottom(true);
}

function activeConversation() {
    return state.conversations.find(c => c.id === state.activeId) || null;
}

// ---------------------------------------------------------
// RENDER
// ---------------------------------------------------------

function renderIdentity() {
    const p = state.profiles.get(state.me.id);
    const name = p?.display_name || p?.username || "You";
    $("meName").textContent = name;
    $("meAvatar").textContent = name.charAt(0).toUpperCase();
    $("meHandle").textContent = p?.username ? "@" + p.username : " ";
}

function renderConversations() {
    const list = $("convList");
    list.replaceChildren();

    if (state.conversations.length === 0) {
        list.append(el("div", "list-note", "No conversations yet."));
        return;
    }

    state.conversations.forEach(conv => {
        const row = el("button", "person-row" + (conv.id === state.activeId ? " active" : ""));
        row.type = "button";

        const text = el("div", "text");
        text.append(el("strong", "", nameOf(conv.other)), el("span", "sub", preview(conv.last)));

        row.append(el("div", "avatar", initialOf(conv.other)), text);

        row.addEventListener("click", () => {
            openConversation(conv.id);
            app.classList.remove("channels-open");
        });

        list.append(row);
    });
}

const IMAGE_URL = /^https:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i;
const GIPHY_URL = /^https:\/\/(media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com|c\.tenor\.com)\/\S+$/i;

function isSafeHttps(url) {
    try {
        return new URL(url).protocol === "https:";
    } catch (_) {
        return false;
    }
}

function linkify(text) {
    const fragment = document.createDocumentFragment();
    const urlPattern = /https:\/\/[^\s<>"']+/g;
    let last = 0;
    let match;

    while ((match = urlPattern.exec(text)) !== null) {
        if (match.index > last) fragment.append(text.slice(last, match.index));

        const a = el("a", "", match[0]);
        a.href = match[0];
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        fragment.append(a);

        last = match.index + match[0].length;
    }

    if (last < text.length) fragment.append(text.slice(last));

    return fragment;
}

function makeImage(url, alt) {
    const img = el("img", "msg-image");
    img.src = url;
    img.alt = alt || "Image";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("click", () => openLightbox(url, alt));
    img.addEventListener("error", () => {
        img.replaceWith(el("div", "msg-user", "[image unavailable]"));
    });
    return img;
}

function buildMessage(message) {
    const mine = message.sender_id === state.me.id;

    const row = el("div", "msg" + (mine ? " mine" : ""));
    row.dataset.id = message.id;

    // Mine on the right (no avatar/name), theirs on the left.
    if (!mine) row.append(el("div", "avatar", initialOf(message.sender_id)));

    const body = el("div", "msg-body");
    const head = el("div", "msg-head");

    if (!mine) head.append(el("span", "msg-author", nameOf(message.sender_id)));
    head.append(el("span", "msg-time", formatTime(message.created_at)));
    body.append(head);

    const text = (message.content || "").trim();
    const bareImage = text && !/\s/.test(text) && (IMAGE_URL.test(text) || GIPHY_URL.test(text));

    if (text && !bareImage) {
        const p = el("div", "msg-text");
        p.append(linkify(text));
        body.append(p);
    }

    if (bareImage) body.append(makeImage(text, "Linked image"));

    if (message.attachment_url && isSafeHttps(message.attachment_url)) {
        body.append(makeImage(message.attachment_url, message.attachment_name));
    }

    if (message.sender_id === state.me.id) {
        const del = el("button", "msg-delete", "Delete");
        del.type = "button";
        del.addEventListener("click", () => deleteMessage(message));
        body.append(del);
    }

    row.append(body);
    return row;
}

function scrollToBottom(force = false) {
    const nearBottom =
        messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 160;

    if (force || nearBottom) messageList.scrollTop = messageList.scrollHeight;
}

// ---------------------------------------------------------
// OPENING A CONVERSATION
// ---------------------------------------------------------

async function openConversation(convId) {
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;

    state.activeId = convId;
    remember("oryn:dm", convId);
    clearPending();

    $("emptyState").hidden = true;
    composer.hidden = false;
    $("chatTitle").textContent = nameOf(conv.other);
    messageInput.placeholder = `Message ${nameOf(conv.other)}`;

    $("dmSettingsBtn").hidden = false;
    joinTypingChannel(convId);

    renderConversations();
    await loadMessages();
    messageInput.focus();
}

async function startConversationWith(userId) {
    hideResults();
    $("dmSearch").value = "";

    const { data, error } = await db.rpc("start_dm", { p_user: userId });

    if (error) {
        console.error("Start DM error:", error);
        toast(errorText(error));
        return;
    }

    await loadConversations();
    await openConversation(data);
}

// ---------------------------------------------------------
// NICKNAMES (private to you)
// ---------------------------------------------------------

async function loadNicknames() {
    const { data, error } = await db
        .from("dm_nicknames")
        .select("target_id, nickname")
        .eq("owner_id", state.me.id);

    if (error) {
        // Table not created yet: DMs still work, just without nicknames.
        console.warn("Nicknames unavailable (run supabase/dm-extras.sql):", error.message);
        return;
    }

    state.nicknames = new Map((data || []).map(n => [n.target_id, n.nickname]));
}

function openNicknameModal() {
    const conv = activeConversation();
    if (!conv) return;

    const real = state.profiles.get(conv.other);
    $("nickTitle").textContent = `Nickname for ${real?.display_name || real?.username || "this person"}`;
    $("nickInput").value = state.nicknames.get(conv.other) || "";
    $("nickError").textContent = "";

    $("nickModal").hidden = false;
    setTimeout(() => $("nickInput").focus(), 30);
}

$("nickForm").addEventListener("submit", async event => {
    event.preventDefault();

    const conv = activeConversation();
    if (!conv) return;

    const nickname = $("nickInput").value.trim().slice(0, 40);
    let error;

    if (nickname) {
        ({ error } = await db
            .from("dm_nicknames")
            .upsert({ owner_id: state.me.id, target_id: conv.other, nickname }, { onConflict: "owner_id,target_id" }));
    } else {
        ({ error } = await db
            .from("dm_nicknames")
            .delete()
            .eq("owner_id", state.me.id)
            .eq("target_id", conv.other));
    }

    if (error) {
        console.error("Nickname error:", error);
        $("nickError").textContent = /does not exist|schema cache/i.test(error.message)
            ? "Run supabase/dm-extras.sql in the Supabase SQL Editor first."
            : error.message;
        return;
    }

    if (nickname) state.nicknames.set(conv.other, nickname);
    else state.nicknames.delete(conv.other);

    closeModals();

    $("chatTitle").textContent = nameOf(conv.other);
    messageInput.placeholder = `Message ${nameOf(conv.other)}`;
    renderConversations();
    await loadMessages();
    toast(nickname ? "Nickname saved." : "Nickname removed.");
});

// ---------------------------------------------------------
// TYPING INDICATOR (live, never stored)
// ---------------------------------------------------------

function typingEnabled() {
    return recall("oryn:typing") !== "off";
}

function joinTypingChannel(convId) {
    leaveTypingChannel();

    const channel = db.channel("typing-" + convId, { config: { broadcast: { self: false } } });

    channel.on("broadcast", { event: "typing" }, ({ payload }) => {
        if (!payload || payload.user === state.me.id) return;
        if (convId !== state.activeId || !typingEnabled()) return;
        showTyping();
    });

    channel.subscribe();
    state.typingChannel = channel;
}

function leaveTypingChannel() {
    if (state.typingChannel) {
        db.removeChannel(state.typingChannel);
        state.typingChannel = null;
    }
    hideTyping();
}

function showTyping() {
    const other = activeConversation()?.other;
    if (!other) return;

    $("typingLine").textContent = `${nameOf(other)} is typing…`;
    $("typingLine").hidden = false;

    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(hideTyping, 4000);
}

function hideTyping() {
    clearTimeout(state.typingTimer);
    $("typingLine").hidden = true;
}

function announceTyping() {
    if (!typingEnabled() || !state.typingChannel) return;

    const now = Date.now();
    if (now - state.lastTypingSent < 2000) return;
    state.lastTypingSent = now;

    state.typingChannel.send({ type: "broadcast", event: "typing", payload: { user: state.me.id } });
}

// ---------------------------------------------------------
// COG MENU: nickname, typing on/off, delete all my messages
// ---------------------------------------------------------

function hideDmMenu() {
    const menu = $("dmMenu");
    menu.hidden = true;
    menu.replaceChildren();
}

$("dmSettingsBtn").addEventListener("click", event => {
    event.stopPropagation();

    const menu = $("dmMenu");

    if (!menu.hidden) {
        hideDmMenu();
        return;
    }

    const conv = activeConversation();
    if (!conv) return;

    menu.replaceChildren();
    menu.append(el("div", "menu-head", nameOf(conv.other)));

    const nick = el("button", "", state.nicknames.has(conv.other) ? "Change nickname" : "Set nickname");
    nick.type = "button";
    nick.addEventListener("click", () => { hideDmMenu(); openNicknameModal(); });
    menu.append(nick);

    const typing = el("button", "menu-check" + (typingEnabled() ? " on" : ""));
    typing.type = "button";
    typing.append(el("span", "", "Show when I'm typing"), el("span", "state", typingEnabled() ? "On" : "Off"));
    typing.addEventListener("click", () => {
        remember("oryn:typing", typingEnabled() ? "off" : "on");
        if (!typingEnabled()) hideTyping();
        hideDmMenu();
        toast(typingEnabled() ? "Typing indicator is on." : "Typing indicator is off.");
    });
    menu.append(typing);

    menu.append(document.createElement("hr"));

    const wipe = el("button", "danger", "Delete all my messages");
    wipe.type = "button";
    wipe.addEventListener("click", () => { hideDmMenu(); deleteAllMine(); });
    menu.append(wipe);

    menu.hidden = false;

    const box = event.currentTarget.getBoundingClientRect();
    menu.style.top = box.bottom + 6 + "px";
    menu.style.left = Math.max(8, box.right - menu.offsetWidth) + "px";
});

document.addEventListener("click", event => {
    if (!event.target.closest("#dmMenu")) hideDmMenu();
});

async function deleteAllMine() {
    const conv = activeConversation();
    if (!conv) return;

    if (!confirm(`Delete every message you've sent to ${nameOf(conv.other)}? This can't be undone.`)) return;

    const { data: mine, error: readError } = await db
        .from("dm_messages")
        .select("id, attachment_url")
        .eq("conversation_id", conv.id)
        .eq("sender_id", state.me.id);

    if (readError) {
        console.error("Delete-all read error:", readError);
        toast(errorText(readError));
        return;
    }

    if (!mine || mine.length === 0) {
        toast("You haven't sent any messages here.");
        return;
    }

    const { error } = await db
        .from("dm_messages")
        .delete()
        .eq("conversation_id", conv.id)
        .eq("sender_id", state.me.id);

    if (error) {
        console.error("Delete-all error:", error);
        toast(errorText(error));
        return;
    }

    // Best effort: remove the uploaded pictures too.
    const marker = `/${ATTACHMENT_BUCKET}/`;
    const paths = mine
        .map(m => m.attachment_url)
        .filter(Boolean)
        .map(url => {
            const i = url.indexOf(marker);
            return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length).split("?")[0]);
        })
        .filter(Boolean);

    if (paths.length) db.storage.from(ATTACHMENT_BUCKET).remove(paths).catch(() => {});

    toast(`Deleted ${mine.length} message${mine.length === 1 ? "" : "s"}.`);

    await loadConversations();
    await loadMessages();
}

// ---------------------------------------------------------
// FIND PEOPLE
// ---------------------------------------------------------

const results = $("dmResults");
let searchTimer = null;
let searchToken = 0;

function hideResults() {
    results.hidden = true;
    results.replaceChildren();
}

$("dmSearch").addEventListener("input", event => {
    clearTimeout(searchTimer);

    // Strip anything that could break the filter syntax.
    const term = event.target.value.trim().replace(/[^\p{L}\p{N}_ .-]/gu, "").slice(0, 30);

    if (term.length < 2) {
        hideResults();
        return;
    }

    searchTimer = setTimeout(() => searchPeople(term), 250);
});

async function searchPeople(term) {
    const token = ++searchToken;

    const { data, error } = await db
        .from("profiles")
        .select("id, username, display_name")
        .or(`username.ilike.%${term}%,display_name.ilike.%${term}%`)
        .neq("id", state.me.id)
        .limit(8);

    if (token !== searchToken) return;

    results.replaceChildren();

    if (error) {
        console.error("Search error:", error);
        results.append(el("div", "none", "Search failed."));
        results.hidden = false;
        return;
    }

    if (!data || data.length === 0) {
        results.append(el("div", "none", "No one found."));
        results.hidden = false;
        return;
    }

    data.forEach(person => {
        state.profiles.set(person.id, person);

        const row = el("button", "person-row");
        row.type = "button";

        const text = el("div", "text");
        text.append(el("strong", "", nameOf(person.id)), el("span", "sub", handleOf(person.id)));

        row.append(el("div", "avatar", initialOf(person.id)), text);
        row.addEventListener("click", () => startConversationWith(person.id));

        results.append(row);
    });

    results.hidden = false;
}

document.addEventListener("click", event => {
    if (!event.target.closest(".dm-search")) hideResults();
    if (!event.target.closest(".srv-channels") && !event.target.closest("#channelsToggle")) {
        app.classList.remove("channels-open");
    }
});

$("channelsToggle").addEventListener("click", event => {
    event.stopPropagation();
    app.classList.toggle("channels-open");
});

// ---------------------------------------------------------
// REALTIME
// ---------------------------------------------------------

function subscribeRealtime() {
    state.realtime = db
        .channel("dm-" + state.me.id)
        .on("postgres_changes",
            { event: "*", schema: "public", table: "dm_messages" },
            onMessageChange)
        .on("postgres_changes",
            { event: "INSERT", schema: "public", table: "dm_conversations" },
            onNewConversation)
        .subscribe();
}

async function onNewConversation() {
    await loadConversations();
}

async function onMessageChange(payload) {
    if (payload.eventType === "INSERT") {
        const message = payload.new;

        // A conversation we haven't listed yet (someone just messaged us).
        if (!state.conversations.some(c => c.id === message.conversation_id)) {
            await loadConversations();
        } else {
            const conv = state.conversations.find(c => c.id === message.conversation_id);
            conv.last = message;
            state.conversations.sort((a, b) =>
                new Date(b.last?.created_at || b.created_at) - new Date(a.last?.created_at || a.created_at)
            );
            renderConversations();
        }

        if (message.conversation_id !== state.activeId) {
            const conv = state.conversations.find(c => c.id === message.conversation_id);
            if (conv && message.sender_id !== state.me.id) toast(`New message from ${nameOf(conv.other)}`);
            return;
        }

        if (messageList.querySelector(`[data-id="${CSS.escape(message.id)}"]`)) return;

        if (message.sender_id !== state.me.id) hideTyping();

        const stick = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 160
            || message.sender_id === state.me.id;

        messageList.append(buildMessage(message));
        if (stick) scrollToBottom(true);
    }

    if (payload.eventType === "DELETE") {
        const old = payload.old;
        if (!old?.id) return;

        messageList.querySelector(`[data-id="${CSS.escape(old.id)}"]`)?.remove();

        const conv = state.conversations.find(c => c.id === old.conversation_id);
        if (conv && conv.last?.id === old.id) await loadConversations();
    }
}

// ---------------------------------------------------------
// SENDING + ATTACHMENTS
// ---------------------------------------------------------

function pickFile(file) {
    if (!file) return;

    if (!FILE_EXTENSIONS[file.type]) {
        toast("Only PNG, JPG, GIF and WebP images are supported.");
        return;
    }

    if (file.size > MAX_FILE_BYTES) {
        toast("That file is too large. The limit is 8 MB.");
        return;
    }

    clearPending();
    state.pendingFile = file;

    const box = $("attachPreview");
    const url = URL.createObjectURL(file);

    const img = el("img");
    img.src = url;
    img.alt = "Attachment preview";

    const meta = el("div", "meta");
    meta.append(
        el("strong", "", file.name || "pasted-image"),
        el("span", "", `${(file.size / 1024).toFixed(file.size > 1024 * 1024 ? 0 : 1)} KB · ${file.type.replace("image/", "").toUpperCase()}`)
    );

    const remove = el("button", "ghost-btn", "Remove");
    remove.type = "button";
    remove.addEventListener("click", clearPending);

    box.replaceChildren(img, meta, remove);
    box.dataset.url = url;
    box.hidden = false;
}

function clearPending() {
    const box = $("attachPreview");

    if (box.dataset.url) {
        URL.revokeObjectURL(box.dataset.url);
        delete box.dataset.url;
    }

    box.replaceChildren();
    box.hidden = true;
    state.pendingFile = null;
    $("fileInput").value = "";
}

async function uploadAttachment(file) {
    const path = `${state.me.id}/${crypto.randomUUID()}.${FILE_EXTENSIONS[file.type]}`;

    const { error } = await db.storage
        .from(ATTACHMENT_BUCKET)
        .upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });

    if (error) throw error;

    return db.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path).data.publicUrl;
}

async function sendMessage() {
    if (state.sending || !state.activeId) return;

    const content = messageInput.value.trim();
    const file = state.pendingFile;

    if (!content && !file) return;

    state.sending = true;
    $("sendBtn").disabled = true;
    $("sendBtn").textContent = file ? "Uploading…" : "Sending…";

    try {
        const row = {
            conversation_id: state.activeId,
            sender_id: state.me.id,
            content
        };

        if (file) {
            row.attachment_url = await uploadAttachment(file);
            row.attachment_type = file.type;
            row.attachment_name = (file.name || "image").slice(0, 200);
        }

        const { error } = await db.from("dm_messages").insert(row);
        if (error) throw error;

        messageInput.value = "";
        autoGrow();
        clearPending();
    } catch (error) {
        console.error("Send error:", error);
        toast(errorText(error));
    } finally {
        state.sending = false;
        $("sendBtn").disabled = false;
        $("sendBtn").textContent = "Send";
        messageInput.focus();
    }
}

async function deleteMessage(message) {
    if (!confirm("Delete this message?")) return;

    const { error } = await db.from("dm_messages").delete().eq("id", message.id);

    if (error) {
        console.error("Delete message error:", error);
        toast(errorText(error));
        return;
    }

    messageList.querySelector(`[data-id="${CSS.escape(message.id)}"]`)?.remove();

    if (message.attachment_url) {
        const marker = `/${ATTACHMENT_BUCKET}/`;
        const index = message.attachment_url.indexOf(marker);
        if (index !== -1) {
            const path = decodeURIComponent(message.attachment_url.slice(index + marker.length).split("?")[0]);
            db.storage.from(ATTACHMENT_BUCKET).remove([path]).catch(() => {});
        }
    }

    await loadConversations();
}

function autoGrow() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + "px";
}

composer.addEventListener("submit", event => {
    event.preventDefault();
    sendMessage();
});

messageInput.addEventListener("input", () => {
    autoGrow();
    if (messageInput.value.trim()) announceTyping();
});

messageInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
    }
});

$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", event => pickFile(event.target.files[0]));

messageInput.addEventListener("paste", event => {
    const item = [...(event.clipboardData?.items || [])].find(i => i.kind === "file" && i.type.startsWith("image/"));
    if (item) {
        event.preventDefault();
        pickFile(item.getAsFile());
    }
});

const chatArea = document.querySelector(".srv-chat");

["dragenter", "dragover"].forEach(type => {
    chatArea.addEventListener(type, event => {
        if (!state.activeId) return;
        if ([...(event.dataTransfer?.types || [])].includes("Files")) {
            event.preventDefault();
            composer.classList.add("drag");
        }
    });
});

["dragleave", "drop"].forEach(type => {
    chatArea.addEventListener(type, event => {
        if (type === "drop") {
            event.preventDefault();
            if (state.activeId) pickFile(event.dataTransfer?.files?.[0]);
        }
        composer.classList.remove("drag");
    });
});

// ---------------------------------------------------------
// INIT
// ---------------------------------------------------------

async function init() {
    if (!db) {
        messageList.replaceChildren(el("div", "list-note", "Supabase is not connected."));
        return;
    }

    const { data, error } = await db.auth.getUser();

    if (error || !data.user) {
        window.location.replace("login.html");
        return;
    }

    state.me = data.user;

    await loadProfiles([state.me.id]);
    renderIdentity();
    await loadNicknames();

    if (!(await loadConversations())) return;

    subscribeRealtime();

    // messages.html?user=<id> opens (or starts) a chat with that person,
    // so profile pages can link straight here.
    const target = new URLSearchParams(location.search).get("user");

    if (target && /^[0-9a-f-]{36}$/i.test(target) && target !== state.me.id) {
        await startConversationWith(target);
        return;
    }

    const saved = recall("oryn:dm");
    const first = state.conversations.find(c => c.id === saved) || state.conversations[0];

    if (first) await openConversation(first.id);
}

init();
