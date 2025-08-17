export default (req, res) => res.status(200).json({ LIAV_KING: true, now: new Date().toISOString() });
