function normalizeShotflowRole(value) {
  return String(value || '').trim().toLowerCase() === 'admin' ? 'admin' : 'artist';
}

function localRoleFromExternal(row) {
  return normalizeShotflowRole(row?.shotflow_role) === 'admin' ? 'admin' : 'user';
}

module.exports = {
  normalizeShotflowRole,
  localRoleFromExternal,
};
