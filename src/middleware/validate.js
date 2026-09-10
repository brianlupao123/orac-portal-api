export function validate(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error.errors) {
        const message = error.errors.map((e) => e.message).join(", ");
        return res.status(400).json({ success: false, message });
      }
      return res.status(400).json({ success: false, message: "Invalid request payload." });
    }
  };
}
