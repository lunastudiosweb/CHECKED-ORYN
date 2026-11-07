
console.log("CHECKED ORYN AUTH.JS LOADED");

const client = window.supabaseClient;

function showMessage(element, message, type = "error") {
    if (!element) return;

    element.textContent = message;
    element.className = `message show ${type}`;
}

const yearElement = document.getElementById("year");

if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
}

// Check Supabase connection
if (!client) {
    console.error("Supabase client is missing.");

    const registerMessage = document.getElementById("registerMessage");
    const loginMessage = document.getElementById("loginMessage");

    showMessage(
        registerMessage || loginMessage,
        "Connection error. Supabase could not initialize. Check your configuration.",
        "error"
    );
}

// =====================================
// REGISTRATION
// =====================================

const registerForm = document.getElementById("registerForm");

if (registerForm) {
    console.log("REGISTER FORM FOUND");

    const message = document.getElementById("registerMessage");
    const button = document.getElementById("registerButton");

    registerForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        console.log("REGISTER BUTTON CLICKED");

        if (!client) {
            showMessage(message, "Supabase is not connected.", "error");
            return;
        }

        const username = document.getElementById("username").value.trim();
        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;
        const confirmPassword = document.getElementById("confirmPassword").value;

        if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
            showMessage(
                message,
                "Username must be 3–24 characters and contain only letters, numbers or underscores."
            );
            return;
        }

        if (password.length < 8) {
            showMessage(message, "Password must contain at least 8 characters.");
            return;
        }

        if (password !== confirmPassword) {
            showMessage(message, "Passwords do not match.");
            return;
        }

        button.disabled = true;
        button.textContent = "Creating account...";

        try {
            console.log("Checking username...");

            const { data: existing, error: lookupError } = await client
                .from("profiles")
                .select("id")
                .ilike("username", username)
                .limit(1);

            if (lookupError) {
                console.error("Username lookup failed:", lookupError);
                throw new Error(
                    "Could not check username: " + lookupError.message
                );
            }

            if (existing && existing.length > 0) {
                showMessage(message, "That username is already taken.");
                return;
            }

            console.log("Username available. Creating account...");

            const { data, error } = await client.auth.signUp({
                email: email,
                password: password,
                options: {
                    data: {
                        username: username,
                        display_name: username
                    }
                }
            });

            if (error) {
                console.error("Supabase signup error:", error);
                throw error;
            }

            console.log("Supabase signup response:", data);

            if (!data.user) {
                throw new Error("Supabase did not return a user. Please try again.");
            }

            if (data.session) {
                showMessage(
                    message,
                    "Your account was created successfully! Redirecting...",
                    "success"
                );

                registerForm.reset();

                setTimeout(() => {
                    window.location.href = "home.html";
                }, 1200);

            } else {
                showMessage(
                    message,
                    "Registration received! Check your email for a confirmation link. Once confirmed, you can log in.",
                    "success"
                );

                registerForm.reset();
            }

        } catch (error) {
            console.error("REGISTRATION FAILED:", error);

            showMessage(
                message,
                error.message || "Registration failed. Please try again."
            );

        } finally {
            button.disabled = false;
            button.innerHTML = 'Create account <span>→</span>';
        }
    });

} else {
    console.log("No registration form found on this page.");
}

// =====================================
// LOGIN
// =====================================

const loginForm = document.getElementById("loginForm");

if (loginForm) {
    console.log("LOGIN FORM FOUND");

    const message = document.getElementById("loginMessage");
    const button = document.getElementById("loginButton");

    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (!client) {
            showMessage(message, "Supabase is not connected.");
            return;
        }

        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;

        button.disabled = true;
        button.textContent = "Logging in...";

        try {
            const { error } = await client.auth.signInWithPassword({
                email,
                password
            });

            if (error) throw error;

            showMessage(message, "Login successful! Redirecting...", "success");

            setTimeout(() => {
                window.location.href = "home.html";
            }, 1000);

        } catch (error) {
            console.error("LOGIN FAILED:", error);

            showMessage(
                message,
                error.message || "Login failed. Please try again."
            );

        } finally {
            button.disabled = false;
            button.innerHTML = 'Log in <span>→</span>';
        }
    });
}
