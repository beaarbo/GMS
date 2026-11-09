// Admins write, edit and delete news posts.
const express = require('express');
const { listNews, getNews, createNews, updateNews, deleteNews } = require('../services');
const { readPost } = require('../news');
const { requireRole, notFound } = require('./helpers');

const router = express.Router();
router.use(requireRole('admin'));

const EMPTY = { title: '', body: '', audience: 'public', pinned: 0 };

function form(res, { post = EMPTY, action, errors = [], status = 200, editing = false }) {
  return res.status(status).render('admin/news_form', {
    title: editing ? 'Edit news post' : 'New news post',
    post,
    action,
    errors,
    editing,
  });
}

router.get('/', (req, res) => {
  res.render('admin/news', { title: 'News', posts: listNews(req.app.locals.db, { signedIn: true, limit: 500 }) });
});

router.get('/new', (req, res) => form(res, { action: '/admin/news' }));

router.post('/', (req, res) => {
  const { values, errors } = readPost(req.body);
  if (errors.length > 0) return form(res, { post: values, action: '/admin/news', errors, status: 400 });
  const id = createNews(req.app.locals.db, values, req.user.id);
  req.logActivity('news.posted', `Posted news: ${values.title}`);
  req.flash('success', 'News post published.');
  return res.redirect(`/news/${id}`);
});

router.get('/:id(\\d+)/edit', (req, res) => {
  const post = getNews(req.app.locals.db, req.params.id);
  if (!post) return notFound(res);
  return form(res, { post, action: `/admin/news/${post.id}`, editing: true });
});

router.post('/:id(\\d+)', (req, res) => {
  const { db } = req.app.locals;
  const post = getNews(db, req.params.id);
  if (!post) return notFound(res);
  const { values, errors } = readPost(req.body);
  if (errors.length > 0) {
    return form(res, { post: { ...values, id: post.id }, action: `/admin/news/${post.id}`, errors, status: 400, editing: true });
  }
  updateNews(db, post.id, values);
  req.logActivity('news.updated', `Updated news: ${values.title}`);
  req.flash('success', 'News post updated.');
  return res.redirect(`/news/${post.id}`);
});

router.post('/:id(\\d+)/delete', (req, res) => {
  const { db } = req.app.locals;
  const post = getNews(db, req.params.id);
  if (post && deleteNews(db, post.id)) {
    req.logActivity('news.deleted', `Deleted news: ${post.title}`);
    req.flash('success', 'News post deleted.');
  }
  return res.redirect('/admin/news');
});

module.exports = router;
