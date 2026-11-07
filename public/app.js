// Progressive enhancement only: every feature also works through plain forms.
document.addEventListener('submit', (event) => {
  const submitter = event.submitter;
  const message = (submitter && submitter.dataset.confirm) || event.target.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});

// Enter in a rejection reason must not trigger the form's first button, "Approve ticked".
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('.note-input')) event.preventDefault();
});

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-check-all]')) {
    document.querySelectorAll('input[name="ids"]').forEach((box) => {
      box.checked = event.target.checked;
    });
  }
  // Ticking a fighter moves focus to their weight class, which is required.
  if (event.target.matches('input[name="fighter_ids"]')) {
    const weight = document.querySelector(`select[name="weight_class_${event.target.value}"]`);
    if (weight) {
      weight.required = event.target.checked;
      if (event.target.checked) weight.focus();
    }
  }
});
