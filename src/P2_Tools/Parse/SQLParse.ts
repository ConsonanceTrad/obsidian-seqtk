export const SQL_SELECT = (url:string, uid:string):string =>
    "SELECT * FROM " + url + " WHERE uid = ?";
