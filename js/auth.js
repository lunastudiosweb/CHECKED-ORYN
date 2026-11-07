
const client = window.supabaseClient;

function showMessage(element, message, type) {
    if (!element) return;

    element.textContent = message;
    element.className = `message show ${type}`;
}

const yearElement = document.getElementById("year");

if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
}

// REGISTRATION
const registerForm = document.getElementById("registerForm");

if (registerForm) {
    const message = document.getElementById("registerMessage");
    const button = document.getElementById("registerButton");

    registerForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        const username = document.getElementById("username").value.trim();
        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;
        const confirmPassword = document.getElementById("confirmPassword").value;

        if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
            return showMessage(message, "Username must be 3–24 characters and use only letters, numbers or underscores.", "error");
        }

        if (password.length < 8) {
            return showMessage(message, "Password must contain at least 8 characters.", "error");
        }

        if (password !== confirmPassword) {
            return showMessage(message, "Passwords do not match.", "error");
        }

        button.disabled = true;
        button.textContent = "Creating account...";

        try {
            const { data: existing, error: lookupError } = await client
                .from("profiles")
                .select("id")
                .ilike("username", username)
                .maybeSingle();

            if (lookupError) throw lookupError;

            if (existing) {
                showMessage(message, "That username is already taken.", "error");
                return;
            }

            const { data, error } = await client.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        username: username,
                        display_name: username
                    }
                }
            });

            if (error) throw error;

            if (data.session) {
                showMessage(message, "Account created! Taking you to CHECKED ORYN...", "success");

                setTimeout(() => {
                    window.location.href = "home.html";
                }, 1000);
            } else {
                showMessage(message, "Account created! Check your email for a confirmation link. Then log in.", "success");
                registerForm.reset();
            }

        } catch (error) {
            console.error("Registration error:", error);
            showMessage(message, error.message || "Registration failed. Please try again.", "error");
        } finally {
            button.disabled = false;
            button.innerHTML = 'Create account <span>→</span>';
        }
    });
}

// LOGIN
const loginForm = document.getElementById("loginForm");

if (loginForm) {
    const message = document.getElementById("loginMessage");
    const button = document.getElementById("loginButton");

    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();

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
            }, 700);

        } catch (error) {
            console.error("Login error:", error);
            showMessage(message, "Login failed. Check your email and password, and make sure your email is confirmed.", "error");
        } finally {
            button.disabled = false;
            button.innerHTML = 'Log in <span>→</span>';
        }
    });
}
