
const exploreClient = window.supabaseClient;

const searchInput = document.getElementById("exploreSearch");
const clearSearchButton = document.getElementById("clearSearch");
const resultsContainer = document.getElementById("exploreResults");
const resultsTitle = document.getElementById("resultsTitle");
const resultsDescription = document.getElementById("resultsDescription");
const sortSelect = document.getElementById("postSort");
const messageElement = document.getElementById("exploreMessage");
const tabs = document.querySelectorAll(".explore-tab");

let activeTab = "posts";
let searchTerm = "";
let searchTimer = null;

document.getElementById("exploreYear").textContent =
    new Date().getFullYear();

function makeElement(tag, className = "", text = "") {
    const element = document.createElement(tag);

    if (className) element.className = className;
    element.textContent = text;

    return element;
}

function showMessage(message) {
    messageElement.textContent = message;
}

function showLoading() {
    resultsContainer.replaceChildren(
        makeElement("div", "explore-loading", "Loading...")
    );
}

function showEmpty(title, description) {
    const empty = makeElement("div", "explore-empty");
    empty.append(
        makeElement("h3", "", title),
        makeElement("p", "", description)
    );

    resultsContainer.replaceChildren(empty);
}

function formatDate(date) {
    return new Date(date).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short"
    });
}

function profileLink(userId) {
    return `profile.html?id=${encodeURIComponent(userId)}`;
}

// ==========================================
// POST DISCOVERY
// ==========================================

async function loadExplorePosts() {
    showLoading();

    resultsTitle.textContent = searchTerm
        ? "Matching posts"
        : "Recent posts";

    resultsDescription.textContent = searchTerm
        ? `Posts matching "${searchTerm}"`
        : "See what everyone is sharing.";

    sortSelect.hidden = false;

    let query = exploreClient
        .from("posts")
        .select("id, user_id, content, created_at");

    if (searchTerm) {
        query = query.ilike("content", `%${searchTerm}%`);
    }

    query = query
        .order("created_at", {
            ascending: sortSelect.value === "oldest"
        })
        .limit(40);

    const { data: posts, error } = await query;

    if (error) {
        console.error("Explore posts error:", error);
        showEmpty("Couldn't load posts", "Please refresh and try again.");
        return;
    }

    if (!posts || posts.length === 0) {
        showEmpty(
            "No posts found",
            searchTerm
                ? "Try another search."
                : "There aren't any posts to discover yet."
        );
        return;
    }

    const userIds = [...new Set(posts.map(post => post.user_id))];
    const postIds = posts.map(post => post.id);

    const [profilesResult, likesResult] = await Promise.all([
        exploreClient
            .from("profiles")
            .select("id, username, display_name")
            .in("id", userIds),

        exploreClient
            .from("post_likes")
            .select("post_id, user_id")
            .in("post_id", postIds)
    ]);

    if (profilesResult.error) {
        console.error("Explore profiles error:", profilesResult.error);
    }

    if (likesResult.error) {
        console.error("Explore likes error:", likesResult.error);
    }

    const profileMap = new Map(
        (profilesResult.data || []).map(profile => [
            profile.id,
            profile
        ])
    );

    const likes = likesResult.data || [];

    const fragment = document.createDocumentFragment();

    posts.forEach(post => {
        const profile = profileMap.get(post.user_id);

        const username = profile?.username || "unknown";
        const displayName = profile?.display_name || username;

        const card = makeElement("article", "explore-post");

        const author = makeElement("div", "explore-post-author");

        const avatar = makeElement(
            "div",
            "explore-avatar",
            displayName.charAt(0).toUpperCase()
        );

        const authorInfo = makeElement("div", "explore-author-info");

        const authorLink = makeElement("a", "", displayName);
        authorLink.href = profileLink(post.user_id);

        const usernameText = makeElement("span", "", "@" + username);

        authorInfo.append(authorLink, usernameText);
        author.append(avatar, authorInfo);

        const content = makeElement(
            "p",
            "explore-post-content",
            post.content
        );

        const meta = makeElement("div", "explore-post-meta");

        const likeCount = likes.filter(
            like => like.post_id === post.id
        ).length;

        meta.append(
            makeElement("span", "", formatDate(post.created_at)),
            makeElement(
                "span",
                "",
                `${likeCount} ${likeCount === 1 ? "like" : "likes"}`
            )
        );

        card.append(author, content, meta);
        fragment.append(card);
    });

    resultsContainer.replaceChildren(fragment);
}

// ==========================================
// PEOPLE DISCOVERY
// ==========================================

async function loadExplorePeople() {
    showLoading();

    resultsTitle.textContent = searchTerm
        ? "Matching people"
        : "Discover people";

    resultsDescription.textContent = searchTerm
        ? `People matching "${searchTerm}"`
        : "Find other people on CHECKED ORYN.";

    sortSelect.hidden = true;

    let query = exploreClient
        .from("profiles")
        .select("id, username, display_name, created_at");

    if (searchTerm) {
        const pattern = `%${searchTerm}%`;

        const [usernameResult, displayNameResult] = await Promise.all([
            query.clone
                ? Promise.resolve(null)
                : Promise.resolve(null)
        ]);

        // Search usernames and display names separately.
        const [usernames, displayNames] = await Promise.all([
            exploreClient
                .from("profiles")
                .select("id, username, display_name, created_at")
                .ilike("username", pattern)
                .limit(30),

            exploreClient
                .from("profiles")
                .select("id, username, display_name, created_at")
                .ilike("display_name", pattern)
                .limit(30)
        ]);

        if (usernames.error || displayNames.error) {
            console.error(
                "People search error:",
                usernames.error || displayNames.error
            );

            showEmpty("Search failed", "Please try again.");
            return;
        }

        const uniqueProfiles = new Map();

        [...(usernames.data || []), ...(displayNames.data || [])]
            .forEach(profile => uniqueProfiles.set(profile.id, profile));

        renderPeople([...uniqueProfiles.values()]);
        return;
    }

    const { data: profiles, error } = await query
        .order("created_at", { ascending: false })
        .limit(30);

    if (error) {
        console.error("People loading error:", error);
        showEmpty("Couldn't load people", "Please try again.");
        return;
    }

    renderPeople(profiles || []);
}

function renderPeople(profiles) {
    if (!profiles.length) {
        showEmpty(
            "No people found",
            "Try searching for another username or display name."
        );
        return;
    }

    const fragment = document.createDocumentFragment();

    profiles.forEach(profile => {
        const username = profile.username || "unknown";
        const displayName = profile.display_name || username;

        const card = makeElement("article", "explore-person");

        const avatar = makeElement(
            "div",
            "explore-avatar",
            displayName.charAt(0).toUpperCase()
        );

        const info = makeElement("div", "explore-person-info");

        const name = makeElement("a", "", displayName);
        name.href = profileLink(profile.id);

        const usernameText = makeElement("span", "", "@" + username);

        info.append(name, usernameText);

        const viewLink = makeElement(
            "a",
            "explore-person-link",
            "View profile"
        );

        viewLink.href = profileLink(profile.id);

        card.append(avatar, info, viewLink);
        fragment.append(card);
    });

    resultsContainer.replaceChildren(fragment);
}

// ==========================================
// TAB SWITCHING AND SEARCH
// ==========================================

async function loadActiveTab() {
    showMessage("");

    if (!exploreClient) {
        showEmpty(
            "Supabase isn't connected",
            "Check your Supabase configuration."
        );
        return;
    }

    if (activeTab === "posts") {
        await loadExplorePosts();
    } else {
        await loadExplorePeople();
    }
}

tabs.forEach(tab => {
    tab.addEventListener("click", () => {
        tabs.forEach(item => item.classList.remove("active"));

        tab.classList.add("active");
        activeTab = tab.dataset.tab;

        loadActiveTab();
    });
});

searchInput.addEventListener("input", () => {
    searchTerm = searchInput.value.trim();

    clearTimeout(searchTimer);

    searchTimer = setTimeout(() => {
        loadActiveTab();
    }, 300);
});

clearSearchButton.addEventListener("click", () => {
    searchInput.value = "";
    searchTerm = "";
    loadActiveTab();
});

sortSelect.addEventListener("change", () => {
    if (activeTab === "posts") {
        loadExplorePosts();
    }
});

// ==========================================
// START
// ==========================================

loadActiveTab();
