/**
 * ADT 类型推断与路径解析
 */

function guessType(name) {
  const upper = name.toUpperCase();
  if (upper.startsWith('CL_') || upper.startsWith('ZCL_')) return 'class';
  if (upper.startsWith('IF_') || upper.startsWith('ZIF_')) return 'interface';
  return 'program';
}

function resolveAdtPath(objPath, type, groupName) {
  if (objPath.startsWith('/sap/bc/adt/')) return objPath;
  const name = objPath.replace(/^.*[/\\\\]/, '');
  switch (type) {
    case 'class':     return `/sap/bc/adt/oo/classes/${name}/source/main`;
    case 'interface': return `/sap/bc/adt/oo/interfaces/${name}/source/main`;
    case 'table':     return `/sap/bc/adt/ddic/tables/${name.toLowerCase()}/source/main`;
    case 'function':  return `/sap/bc/adt/functions/groups/${name.toLowerCase()}/source/main`;

    case 'fm':        return `/sap/bc/adt/functions/groups/${(groupName || name).toLowerCase()}/fmodules/${name.toLowerCase()}/source/main`;
    case 'program':   return `/sap/bc/adt/programs/programs/${name}/source/main`;
    default:          return `/sap/bc/adt/programs/programs/${name}/source/main`;
  }
}

function resolveAdtBase(name, type, groupName) {
  const n = name.replace(/^.*[/\\\\]/, '').toLowerCase();
  switch (type) {
    case 'class':     return `/sap/bc/adt/oo/classes/${n}`;
    case 'interface': return `/sap/bc/adt/oo/interfaces/${n}`;
    case 'function':  return `/sap/bc/adt/functions/groups/${n}`;
    case 'fm':        return `/sap/bc/adt/functions/groups/${(groupName || n).toLowerCase()}/fmodules/${n}`;
    case 'program':   return `/sap/bc/adt/programs/programs/${n}`;
    default:          return `/sap/bc/adt/programs/programs/${n}`;
  }
}

function resolveAdtType(type) {
  switch (type) {
    case 'class':     return 'CLAS/OC';
    case 'interface': return 'INTF/OI';
    case 'function':  return 'FUGR/F';
    case 'fm':        return 'FUGR/FF';
    case 'program':   return 'PROG/P';
    default:          return 'PROG/P';
  }
}

module.exports = { guessType, resolveAdtPath, resolveAdtBase, resolveAdtType };
