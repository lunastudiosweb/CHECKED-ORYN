
const socialClient = window.supabaseClient;

const postContent = document.getElementById("postContent");
const publishButton = document.getElementById("publishPost");
const postsFeed = document.getElementById("postsFeed");
const postMessage = document.getElementById("postMessage");

let currentUser = null;

function createElement(tag, className = "", text = "") {
    const element = document.createElement(tag);

    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;

    return element;
}

function showPostMessage(message) {
    if (postMessage) postMessage.textContent = message;
}

function formatDate(date) {
    return new Date(date).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short"
    });
}

// ==========================================
// LOAD POSTS, LIKES AND COMMENTS
// ==========================================

async function loadPosts() {
    if (!postsFeed) return;

    postsFeed.replaceChildren(
        createElement("div", "feed-empty", "Loading posts...")
    );

    const { data: posts, error } = await socialClient
        .from("posts")
        .select("id, user_id, content, created_at")
        .order("created_at", { ascending: false })
        .limit(25);

    if (error) {
        console.error("Posts error:", error);
        postsFeed.replaceChildren(
            createElement("div", "feed-empty", "Couldn't load posts.")
        );
        return;
    }

    if (!posts || posts.length === 0) {
        postsFeed.replaceChildren();

        const empty = createElement("div", "feed-empty");
        empty.append(
            createElement("h3", "", "Your feed starts here."),
            createElement("p", "", "Be the first to publish something.")
        );

        postsFeed.append(empty);
        return;
    }

    const postIds = posts.map(post => post.id);

    // Load likes
    const { data: likes, error: likesError } = await socialClient
        .from("post_likes")
        .select("post_id, user_id")
        .in("post_id", postIds);

    if (likesError) console.error("Likes error:", likesError);

    // Load comments
    const { data: comments, error: commentsError } = await socialClient
        .from("comments")
        .select("id, post_id, user_id, content, created_at")
        .in("post_id", postIds)
        .order("created_at", { ascending: true });

    if (commentsError) console.error("Comments error:", commentsError);

    // Load all post and comment authors
    const authorIds = new Set();

    posts.forEach(post => authorIds.add(post.user_id));
    (comments || []).forEach(comment => authorIds.add(comment.user_id));

    const { data: profiles, error: profilesError } = await socialClient
        .from("profiles")
        .select("id, username, display_name")
        .in("id", [...authorIds]);

    if (profilesError) console.error("Profiles error:", profilesError);

    const profileMap = new Map(
        (profiles || []).map(profile => [profile.id, profile])
    );

    const commentsByPost = new Map();

    (comments || []).forEach(comment => {
        if (!commentsByPost.has(comment.post_id)) {
            commentsByPost.set(comment.post_id, []);
        }

        commentsByPost.get(comment.post_id).push(comment);
    });

    postsFeed.replaceChildren();

    posts.forEach(post => {
        const profile = profileMap.get(post.user_id);
        const username = profile?.username || "unknown";
        const displayName = profile?.display_name || username;

        const postLikes = (likes || []).filter(
            like => like.post_id === post.id
        );

        const userLiked = postLikes.some(
            like => like.user_id === currentUser.id
        );

        const postComments = commentsByPost.get(post.id) || [];

        const card = createElement("article", "post-card");

        // Post author
        const author = createElement("div", "post-author");

        const avatar = createElement(
            "div",
            "profile-avatar",
            displayName.charAt(0).toUpperCase()
        );

        const authorInfo = createElement("div", "post-author-info");

        authorInfo.append(
            createElement("strong", "", displayName),
            createElement("span", "", "@" + username)
        );

        author.append(avatar, authorInfo);

        // Post content
        const content = createElement("p", "post-content", post.content);

        // Post action area
        const actions = createElement("div", "post-actions");

        const date = createElement(
            "span",
            "post-date",
            formatDate(post.created_at)
        );

        const actionButtons = createElement("div", "post-action-buttons");

        // Like button
        const likeButton = createElement(
            "button",
            userLiked ? "like-button liked" : "like-button",
            `${userLiked ? "♥ Liked" : "♡ Like"} · ${postLikes.length}`
        );

        likeButton.type = "button";

        likeButton.addEventListener("click", async () => {
            likeButton.disabled = true;

            let result;

            if (userLiked) {
                result = await socialClient
                    .from("post_likes")
                    .delete()
                    .eq("post_id", post.id)
                    .eq("user_id", currentUser.id);
            } else {
                result = await socialClient
                    .from("post_likes")
                    .insert({
                        post_id: post.id,
                        user_id: currentUser.id
                    });
            }

            if (result.error) {
                console.error("Like error:", result.error);
                alert("Couldn't update your like. Please try again.");
                likeButton.disabled = false;
                return;
            }

            await loadPosts();
        });

        actionButtons.append(likeButton);

        // Delete own post
        if (post.user_id === currentUser.id) {
            const deleteButton = createElement(
                "button",
                "delete-post",
                "Delete post"
            );

            deleteButton.type = "button";

            deleteButton.addEventListener("click", async () => {
                if (!confirm("Delete this post and its comments?")) return;

                deleteButton.disabled = true;

                const { error } = await socialClient
                    .from("posts")
                    .delete()
                    .eq("id", post.id);

                if (error) {
                    console.error("Post deletion error:", error);
                    alert("Couldn't delete this post.");
                    deleteButton.disabled = false;
                    return;
                }

                await loadPosts();
            });

            actionButtons.append(deleteButton);
        }

        actions.append(date, actionButtons);

        // Comments section
        const commentSection = createElement("section", "comment-section");

        const commentHeading = createElement(
            "h4",
            "comment-heading",
            `Comments (${postComments.length})`
        );

        const commentList = createElement("div", "comment-list");

        if (postComments.length === 0) {
            commentList.append(
                createElement("p", "no-comments", "No comments yet.")
            );
        }

        postComments.forEach(comment => {
            const commentProfile = profileMap.get(comment.user_id);
            const commentUsername = commentProfile?.username || "unknown";
            const commentName =
                commentProfile?.display_name || commentUsername;

            const commentCard = createElement("div", "comment-card");

            const commentTop = createElement("div", "comment-top");

            const commentAuthor = createElement(
                "strong",
                "",
                commentName + " · @" + commentUsername
            );

            const commentDate = createElement(
                "span",
                "comment-date",
                formatDate(comment.created_at)
            );

            commentTop.append(commentAuthor, commentDate);

            const commentText = createElement(
                "p",
                "comment-content",
                comment.content
            );

            commentCard.append(commentTop, commentText);

            // Delete own comment
            if (comment.user_id === currentUser.id) {
                const deleteCommentButton = createElement(
                    "button",
                    "delete-comment",
                    "Delete"
                );

                deleteCommentButton.type = "button";

                deleteCommentButton.addEventListener("click", async () => {
                    if (!confirm("Delete your comment?")) return;

                    deleteCommentButton.disabled = true;

                    const { error } = await socialClient
                        .from("comments")
                        .delete()
                        .eq("id", comment.id);

                    if (error) {
                        console.error("Comment deletion error:", error);
                        alert("Couldn't delete your comment.");
                        deleteCommentButton.disabled = false;
                        return;
                    }

                    await loadPosts();
                });

                commentCard.append(deleteCommentButton);
            }

            commentList.append(commentCard);
        });

        // New comment form
        const commentForm = createElement("form", "comment-form");

        const commentInput = createElement(
            "textarea",
            "comment-input"
        );

        commentInput.placeholder = "Write a comment...";
        commentInput.maxLength = 1000;
        commentInput.required = true;
        commentInput.rows = 2;

        const commentButton = createElement(
            "button",
            "comment-submit",
            "Comment"
        );

        commentButton.type = "submit";

        commentForm.append(commentInput, commentButton);

        commentForm.addEventListener("submit", async event => {
            event.preventDefault();

            const commentText = commentInput.value.trim();

            if (!commentText) return;

            commentButton.disabled = true;
            commentButton.textContent = "Sending...";

            const { error } = await socialClient
                .from("comments")
                .insert({
                    post_id: post.id,
                    user_id: currentUser.id,
                    content: commentText
                });

            if (error) {
                console.error("Comment error:", error);
                alert("Couldn't send your comment. Please try again.");

                commentButton.disabled = false;
                commentButton.textContent = "Comment";
                return;
            }

            await loadPosts();
        });

        commentSection.append(
            commentHeading,
            commentList,
            commentForm
        );

        card.append(
            author,
            content,
            actions,
            commentSection
        );

        postsFeed.append(card);
    });
}

// ==========================================
// PUBLISH POSTS
// ==========================================

async function publishPost() {
    const content = postContent.value.trim();

    if (!content) {
        showPostMessage("Write something before publishing.");
        return;
    }

    if (content.length > 2000) {
        showPostMessage("Posts cannot exceed 2,000 characters.");
        return;
    }

    publishButton.disabled = true;
    publishButton.textContent = "Publishing...";
    showPostMessage("Publishing your post...");

    const { error } = await socialClient
        .from("posts")
        .insert({
            user_id: currentUser.id,
            content
        });

    if (error) {
        console.error("Publishing error:", error);
        showPostMessage("Couldn't publish. Please try again.");

        publishButton.disabled = false;
        publishButton.textContent = "Publish";
        return;
    }

    postContent.value = "";
    showPostMessage("Your post has been published!");

    publishButton.disabled = false;
    publishButton.textContent = "Publish";

    await loadPosts();
}

// ==========================================
// INITIALIZE
// ==========================================

async function initializeSocial() {
    if (!socialClient) {
        showPostMessage("Supabase is not connected.");
        return;
    }

    const { data, error } = await socialClient.auth.getUser();

    if (error || !data.user) {
        window.location.replace("login.html");
        return;
    }

    currentUser = data.user;

    if (publishButton) {
        publishButton.addEventListener("click", publishPost);
    }

    await loadPosts();
}

initializeSocial();
