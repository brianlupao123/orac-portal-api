export function validate(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      const issues = Array.isArray(error?.issues) ? error.issues : error?.errors;
      if (Array.isArray(issues) && issues.length > 0) {
        const message = issues.map((issue) => issue.message).join(", ");
        return res.status(400).json({ success: false, message });
      }
      return res.status(400).json({ success: false, message: "Invalid request payload." });
    }
  };
}
