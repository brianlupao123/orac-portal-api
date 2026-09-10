import { generateToken } from "../middleware/auth.js";
import { config } from "../config.js";
import bcrypt from "bcrypt";

export const loginDemoUser = (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = req.body.password;
  const user = req.db.users.find((item) => item.email.toLowerCase() === email && item.is_active);
  
  if (!user) {
    return res.status(401).json({ success: false, message: "User not found or inactive." });
  }

  if (config.isProduction || password) {
    if (!password) {
      return res.status(401).json({ success: false, message: "Password is required." });
    }
    // Backward compatibility for old DBs without password_hash
    const valid = user.password_hash 
      ? bcrypt.compareSync(password, user.password_hash)
      : password === "password123"; 
      
    if (!valid) {
      return res.status(401).json({ success: false, message: "Invalid credentials." });
    }
  }

  user.last_login = new Date().toISOString();
  
  // Create token
  const token = generateToken(user);

  req.store.audit(req.db, user, "user", user.id, "DEMO_LOGIN", null, { id: user.id, email: user.email, role: user.role });

  res.json({
    success: true,
    data: {
      user,
      token,
      note: "JWT Login successful"
    }
  });
};

export const getMe = (req, res) => {
  // authMiddleware attached req.user
  const user = req.db.users.find((item) => item.id === req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found." });
  }
  res.json({ success: true, data: user });
};
